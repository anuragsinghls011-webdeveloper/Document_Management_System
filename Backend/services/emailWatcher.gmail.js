/**
 * @module services/emailWatcher.gmail
 * @description Gmail API-based email watcher using googleapis with OAuth2.
 *
 * Architecture:
 * 1. Authenticates via OAuth2 (client_id + client_secret + refresh_token)
 * 2. On first run, fetches unread messages with attachments in batches
 * 3. Enters a polling loop (configurable interval, default 60s)
 * 4. Uses historyId for efficient incremental fetching after initial sync
 * 5. After processing, removes UNREAD label from messages
 *
 * Why polling instead of Pub/Sub:
 * Google Pub/Sub push notifications (users.watch) require:
 * - A GCP project with Cloud Pub/Sub enabled
 * - A verified push endpoint (public HTTPS URL)
 * - IAM permissions for the Gmail API service account
 * This is the right approach for production but adds infrastructure complexity.
 * This module uses polling as a self-contained fallback.
 * See EMAIL_INGESTION_README.md for Pub/Sub upgrade instructions.
 *
 * Why exponential backoff:
 * Gmail API has rate limits (250 quota units/second for free, higher for Workspace).
 * Backing off on errors prevents quota exhaustion and aligns with Google's
 * recommended retry strategy.
 */

const { google } = require('googleapis');
const { config } = require('../config/emailConfig');
const { processEmail } = require('./emailIngestionService');

// ─── State ───────────────────────────────────────────────────────────────────

let gmail = null;
let isRunning = false;
let isStopping = false;
let pollTimer = null;

// Track the latest historyId for incremental fetching.
// After the initial full sync, we only need to ask for changes since this ID.
let lastHistoryId = null;

// Exponential backoff state
let consecutiveErrors = 0;
const BASE_ERROR_DELAY_MS = 5000;       // 5 seconds on first error
const MAX_ERROR_DELAY_MS = 5 * 60 * 1000; // Cap at 5 minutes

// ─── Auth Setup ──────────────────────────────────────────────────────────────

/**
 * Creates and configures an OAuth2 client for Gmail API access.
 * The refresh token is used to obtain access tokens automatically —
 * no user interaction needed after initial setup.
 *
 * @returns {google.auth.OAuth2} Configured OAuth2 client
 */
function createOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri
  );

  oauth2Client.setCredentials({
    refresh_token: config.gmail.refreshToken,
  });

  return oauth2Client;
}

// ─── Gmail API Helpers ───────────────────────────────────────────────────────

/**
 * Fetches a single message by ID with full format (includes attachments).
 *
 * @param {string} messageId - Gmail message ID
 * @returns {Promise<Object|null>} Gmail message object or null on error
 */
async function fetchMessage(messageId) {
  try {
    const response = await gmail.users.messages.get({
      userId: config.gmail.userEmail,
      id: messageId,
      format: 'full',
    });
    return response.data;
  } catch (err) {
    console.error(`[Gmail] Failed to fetch message ${messageId}: ${err.message}`);
    return null;
  }
}

/**
 * Downloads a specific attachment from a message.
 * Gmail stores large attachments separately and returns them base64-encoded.
 *
 * @param {string} messageId - Gmail message ID
 * @param {string} attachmentId - Attachment ID within the message
 * @returns {Promise<Buffer|null>} Attachment content as a Buffer
 */
async function downloadAttachment(messageId, attachmentId) {
  try {
    const response = await gmail.users.messages.attachments.get({
      userId: config.gmail.userEmail,
      messageId,
      id: attachmentId,
    });

    // Gmail returns base64url-encoded data
    const data = response.data.data;
    return Buffer.from(data, 'base64');
  } catch (err) {
    console.error(`[Gmail] Failed to download attachment ${attachmentId} from message ${messageId}: ${err.message}`);
    return null;
  }
}

/**
 * Extracts the sender email from Gmail message headers.
 *
 * @param {Object} message - Gmail message object
 * @returns {string} Sender email address
 */
function extractSender(message) {
  const headers = message.payload?.headers || [];
  const from = headers.find(h => h.name.toLowerCase() === 'from');
  if (!from) return '';

  // Extract email from "Name <email>" format
  const match = from.value.match(/<([^>]+)>/);
  return match ? match[1] : from.value;
}

/**
 * Extracts a header value by name from Gmail message headers.
 *
 * @param {Object} message - Gmail message object
 * @param {string} headerName - Header name (case-insensitive)
 * @returns {string} Header value or empty string
 */
function getHeader(message, headerName) {
  const headers = message.payload?.headers || [];
  const header = headers.find(h => h.name.toLowerCase() === headerName.toLowerCase());
  return header ? header.value : '';
}

/**
 * Recursively extracts attachment parts from a Gmail message payload.
 * Gmail uses a nested MIME tree structure — attachments can be at any depth.
 *
 * @param {Object} payload - Gmail message payload
 * @returns {Array<Object>} Array of attachment part objects
 */
function extractAttachmentParts(payload) {
  const parts = [];

  if (!payload) return parts;

  // Check if this part itself is an attachment
  if (payload.body?.attachmentId && payload.filename) {
    parts.push(payload);
  }

  // Recurse into sub-parts (multipart messages)
  if (payload.parts) {
    for (const part of payload.parts) {
      parts.push(...extractAttachmentParts(part));
    }
  }

  return parts;
}

/**
 * Marks a Gmail message as read by removing the UNREAD label.
 *
 * @param {string} messageId - Gmail message ID
 */
async function markAsRead(messageId) {
  try {
    await gmail.users.messages.modify({
      userId: config.gmail.userEmail,
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD'],
      },
    });
  } catch (err) {
    console.warn(`[Gmail] Failed to mark message ${messageId} as read: ${err.message}`);
  }
}

// ─── Core Processing ─────────────────────────────────────────────────────────

/**
 * Processes a single Gmail message: fetches full content, downloads
 * attachments, and passes them to the shared ingestion service.
 *
 * @param {string} messageId - Gmail message ID
 * @returns {Promise<boolean>} True if processed successfully
 */
async function processGmailMessage(messageId) {
  const message = await fetchMessage(messageId);
  if (!message) return false;

  const sender = extractSender(message);
  const subject = getHeader(message, 'subject');
  const dateStr = getHeader(message, 'date');
  const gmailMessageId = getHeader(message, 'message-id') || messageId;
  const receivedAt = dateStr ? new Date(dateStr) : new Date(parseInt(message.internalDate, 10));

  // Extract all attachment parts from the MIME tree
  const attachmentParts = extractAttachmentParts(message.payload);

  if (attachmentParts.length === 0) {
    // No attachments — mark as read and skip
    await markAsRead(messageId);
    return true;
  }

  // Download each attachment and build the array for processEmail
  const attachments = [];
  for (const part of attachmentParts) {
    const content = await downloadAttachment(messageId, part.body.attachmentId);
    if (content) {
      attachments.push({
        filename: part.filename || '',
        mimeType: part.mimeType || '',
        size: part.body.size || content.length,
        content,
      });
    }
  }

  // Call the shared processing orchestrator
  const result = await processEmail({
    messageId: gmailMessageId,
    sender,
    subject,
    receivedAt,
    source: 'gmail',
    attachments,
  });

  if (result.processed) {
    await markAsRead(messageId);
  }

  return result.processed;
}

/**
 * Performs the initial sync: fetches all unread messages with attachments
 * in controlled batches.
 *
 * @returns {Promise<void>}
 */
async function initialSync() {
  console.info('[Gmail] Starting initial sync of unread messages...');

  let pageToken = null;
  let totalProcessed = 0;

  do {
    if (isStopping) break;

    try {
      // Query for unread messages with attachments
      const response = await gmail.users.messages.list({
        userId: config.gmail.userEmail,
        q: 'is:unread has:attachment',
        maxResults: config.batchSize,
        pageToken: pageToken || undefined,
      });

      const messages = response.data.messages || [];
      pageToken = response.data.nextPageToken || null;

      if (messages.length === 0) {
        console.info('[Gmail] No unread messages with attachments found');
        break;
      }

      console.info(`[Gmail] Processing batch of ${messages.length} message(s)...`);

      for (const msg of messages) {
        if (isStopping) break;

        try {
          await processGmailMessage(msg.id);
          totalProcessed++;
        } catch (err) {
          console.error(`[Gmail] Failed to process message ${msg.id}: ${err.message}`);
        }
      }

      // Small delay between batches to respect rate limits
      if (pageToken && !isStopping) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (err) {
      console.error(`[Gmail] Initial sync batch error: ${err.message}`);
      break;
    }
  } while (pageToken && !isStopping);

  if (totalProcessed > 0) {
    console.info(`[Gmail] Initial sync complete: ${totalProcessed} message(s) processed`);
  }

  // Capture the latest historyId for incremental fetching
  try {
    const profile = await gmail.users.getProfile({
      userId: config.gmail.userEmail,
    });
    lastHistoryId = profile.data.historyId;
    console.info(`[Gmail] Baseline historyId: ${lastHistoryId}`);
  } catch (err) {
    console.warn(`[Gmail] Could not get profile historyId: ${err.message}`);
  }
}

/**
 * Polls for new messages since the last known historyId.
 * This is much more efficient than re-listing all unread messages because
 * the History API only returns changes (new messages, label changes, etc.)
 * since the specified historyId.
 *
 * Falls back to a full list query if historyId is unavailable or expired.
 *
 * @returns {Promise<void>}
 */
async function pollForNewMessages() {
  if (isStopping) return;

  try {
    let messageIds = [];

    if (lastHistoryId) {
      // ─── Incremental Fetch via History API ───────────────────────────
      try {
        const response = await gmail.users.history.list({
          userId: config.gmail.userEmail,
          startHistoryId: lastHistoryId,
          historyTypes: ['messageAdded'],
          labelId: 'INBOX',
        });

        const histories = response.data.history || [];
        for (const h of histories) {
          const added = h.messagesAdded || [];
          for (const m of added) {
            // Only process messages that still have UNREAD label
            if (m.message.labelIds && m.message.labelIds.includes('UNREAD')) {
              messageIds.push(m.message.id);
            }
          }
        }

        // Update historyId for next poll
        if (response.data.historyId) {
          lastHistoryId = response.data.historyId;
        }
      } catch (historyErr) {
        // History ID may have expired (Google keeps ~7 days of history).
        // Fall back to list query.
        if (historyErr.code === 404) {
          console.warn('[Gmail] HistoryId expired — falling back to full list query');
          lastHistoryId = null;
        } else {
          throw historyErr;
        }
      }
    }

    // Fallback: if no historyId or it expired, list unread messages
    if (!lastHistoryId) {
      const response = await gmail.users.messages.list({
        userId: config.gmail.userEmail,
        q: 'is:unread has:attachment',
        maxResults: config.batchSize,
      });

      messageIds = (response.data.messages || []).map(m => m.id);

      // Re-capture historyId
      const profile = await gmail.users.getProfile({
        userId: config.gmail.userEmail,
      });
      lastHistoryId = profile.data.historyId;
    }

    // Deduplicate message IDs (history API can return duplicates)
    messageIds = [...new Set(messageIds)];

    if (messageIds.length > 0) {
      console.info(`[Gmail] Found ${messageIds.length} new message(s) to process`);

      for (const id of messageIds) {
        if (isStopping) break;
        try {
          await processGmailMessage(id);
        } catch (err) {
          console.error(`[Gmail] Failed to process message ${id}: ${err.message}`);
        }
      }
    }

    // Reset error counter on successful poll
    consecutiveErrors = 0;

  } catch (err) {
    consecutiveErrors++;
    console.error(`[Gmail] Poll error (attempt #${consecutiveErrors}): ${err.message}`);

    // On repeated errors, increase the delay between polls
    if (consecutiveErrors >= 3) {
      const errorDelay = Math.min(
        BASE_ERROR_DELAY_MS * Math.pow(2, consecutiveErrors - 3),
        MAX_ERROR_DELAY_MS
      );
      console.warn(`[Gmail] ${consecutiveErrors} consecutive errors — backing off ${(errorDelay / 1000).toFixed(1)}s`);
      await new Promise(resolve => setTimeout(resolve, errorDelay));
    }
  }
}

/**
 * Main polling loop. Runs pollForNewMessages at the configured interval.
 */
function startPolling() {
  if (isStopping) return;

  const interval = config.pollIntervalMs;
  console.info(`[Gmail] Polling every ${(interval / 1000).toFixed(0)}s for new messages...`);

  const poll = async () => {
    if (isStopping) return;

    await pollForNewMessages();

    if (!isStopping) {
      pollTimer = setTimeout(poll, interval);
    }
  };

  // Start first poll immediately
  pollTimer = setTimeout(poll, 1000);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Starts the Gmail email watcher.
 * Authenticates via OAuth2, performs initial sync, then enters polling mode.
 *
 * @returns {Promise<void>}
 */
async function start() {
  if (isRunning) {
    console.warn('[Gmail] Watcher is already running');
    return;
  }

  console.info('[Gmail] Starting email watcher...');
  isStopping = false;
  consecutiveErrors = 0;

  // Set up OAuth2 client and Gmail API instance
  const auth = createOAuth2Client();
  gmail = google.gmail({ version: 'v1', auth });

  // Verify credentials by fetching the user profile
  try {
    const profile = await gmail.users.getProfile({
      userId: config.gmail.userEmail,
    });
    console.info(`[Gmail] Authenticated as: ${profile.data.emailAddress} (${profile.data.messagesTotal} total messages)`);
  } catch (err) {
    console.error(`[Gmail] Authentication failed: ${err.message}`);
    throw new Error(`Gmail authentication failed: ${err.message}`);
  }

  isRunning = true;

  // Perform initial sync of existing unread messages
  await initialSync();

  // Enter polling mode for new messages
  startPolling();
}

/**
 * Gracefully stops the Gmail watcher.
 * Cancels the polling timer and cleans up state.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  console.info('[Gmail] Stopping email watcher...');
  isStopping = true;
  isRunning = false;

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  gmail = null;
  lastHistoryId = null;
  consecutiveErrors = 0;

  console.info('[Gmail] Email watcher stopped');
}

module.exports = { start, stop };
