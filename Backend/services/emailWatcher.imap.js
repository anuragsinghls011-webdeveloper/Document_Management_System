/**
 * @module services/emailWatcher.imap
 * @description IMAP-based email watcher using imapflow + mailparser.
 *
 * Architecture:
 * 1. Connects to the IMAP server with TLS
 * 2. Opens the configured folder (default: INBOX)
 * 3. Processes any existing unseen emails in controlled batches
 * 4. Enters IDLE mode to receive real-time push notifications for new mail
 * 5. On connection drop, reconnects with exponential backoff
 *
 * Why IDLE instead of polling:
 * - IMAP IDLE is a server-push mechanism (RFC 2177) that notifies the client
 *   instantly when new mail arrives. No wasted bandwidth from polling.
 * - imapflow handles IDLE keepalive internally, re-issuing IDLE commands
 *   before the server's 30-minute timeout.
 *
 * Why exponential backoff on reconnect:
 * - Prevents hammering a temporarily-down server
 * - Starts fast (1s) for transient glitches, grows to 5min max for prolonged outages
 * - Resets to 1s on successful reconnection
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { config } = require('../config/emailConfig');
const { processEmail } = require('./emailIngestionService');

// ─── State ───────────────────────────────────────────────────────────────────

let client = null;
let isRunning = false;
let isStopping = false;

// Exponential backoff state for reconnection
let reconnectAttempt = 0;
const BASE_RECONNECT_DELAY_MS = 1000;    // Start at 1 second
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000; // Cap at 5 minutes
let reconnectTimer = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Calculates the next reconnect delay using exponential backoff with jitter.
 * Jitter prevents "thundering herd" if multiple workers reconnect simultaneously.
 *
 * @returns {number} Delay in milliseconds
 */
function getReconnectDelay() {
  const exponentialDelay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt),
    MAX_RECONNECT_DELAY_MS
  );
  // Add ±20% jitter to prevent synchronized reconnection storms
  const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
  return Math.max(BASE_RECONNECT_DELAY_MS, Math.floor(exponentialDelay + jitter));
}

/**
 * Extracts a clean sender email address from parsed mail headers.
 * Handles formats like: "John Doe <john@example.com>", "<john@example.com>", "john@example.com"
 *
 * @param {Object} parsed - Parsed email from mailparser
 * @returns {string} Sender email address
 */
function extractSender(parsed) {
  if (parsed.from && parsed.from.value && parsed.from.value.length > 0) {
    return parsed.from.value[0].address || '';
  }
  return '';
}

// ─── Core Processing ─────────────────────────────────────────────────────────

/**
 * Processes a batch of unseen messages from the mailbox.
 * Called on initial connection (backlog) and when IDLE notifies of new mail.
 *
 * @param {ImapFlow} imapClient - Connected IMAP client
 * @param {number} batchSize - Max messages to process in this batch
 * @returns {Promise<number>} Number of emails processed
 */
async function processUnseenBatch(imapClient, batchSize) {
  let processed = 0;

  try {
    // Lock the mailbox — required by imapflow before fetch operations.
    // The lock ensures sequential access and prevents conflicts with IDLE.
    const lock = await imapClient.getMailboxLock(config.imap.folder);

    try {
      // Search for unseen (unread) messages
      // Using IMAP SEARCH command — efficient, server-side filtering
      const messages = await imapClient.search({ seen: false }, { uid: true });

      if (!messages || messages.length === 0) {
        console.info('[IMAP] No unseen messages found');
        return 0;
      }

      console.info(`[IMAP] Found ${messages.length} unseen message(s), processing batch of ${Math.min(messages.length, batchSize)}`);

      // Process in controlled batches to avoid overwhelming the system
      const batch = messages.slice(0, batchSize);

      for (const uid of batch) {
        if (isStopping) break;

        try {
          // Fetch the full message (headers + body + attachments)
          // Using UID-based fetch for reliability across sessions
          const message = await imapClient.fetchOne(uid, {
            source: true, // Get raw RFC 822 source for parsing
            uid: true,
          });

          if (!message || !message.source) {
            console.warn(`[IMAP] Could not fetch message UID ${uid} — skipping`);
            continue;
          }

          // Parse the raw email using mailparser
          // simpleParser handles MIME decoding, charset conversion, and attachment extraction
          const parsed = await simpleParser(message.source);

          // Build the attachment array in the format processEmail expects
          const attachments = (parsed.attachments || []).map(att => ({
            filename: att.filename || '',
            mimeType: att.contentType || '',
            size: att.size || (att.content ? att.content.length : 0),
            content: att.content, // Buffer
          }));

          // Call the shared processing orchestrator
          const result = await processEmail({
            messageId: parsed.messageId || `imap-uid-${uid}-${Date.now()}`,
            sender: extractSender(parsed),
            subject: parsed.subject || '',
            receivedAt: parsed.date || new Date(),
            source: 'imap',
            attachments,
          });

          if (result.processed) {
            // Mark the message as \Seen (read) on the IMAP server
            // This prevents re-fetching on the next search and is the
            // primary dedup mechanism at the IMAP level. The ProcessedEmail
            // collection is a secondary safety net for crash recovery.
            await imapClient.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            processed++;
          }
        } catch (msgErr) {
          // Individual message failure should NOT stop the batch
          console.error(`[IMAP] Failed to process message UID ${uid}: ${msgErr.message}`);
        }
      }
    } finally {
      // Always release the mailbox lock — even if processing threw an error.
      // Failing to release the lock would deadlock the IMAP client.
      lock.release();
    }
  } catch (err) {
    console.error(`[IMAP] Batch processing error: ${err.message}`);
  }

  return processed;
}

// ─── Connection Management ───────────────────────────────────────────────────

/**
 * Establishes the IMAP connection, processes backlog, and enters IDLE mode.
 * This is the main loop that runs for the lifetime of the watcher.
 */
async function connect() {
  if (isStopping) return;

  console.info(`[IMAP] Connecting to ${config.imap.host}:${config.imap.port}...`);

  client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.tls,
    auth: {
      user: config.imap.user,
      // Note: we log the user but NEVER the password — security requirement
      pass: config.imap.password,
    },
    logger: false, // Suppress imapflow's verbose internal logging
    // emitLogs: false is implicit when logger is false
  });

  try {
    await client.connect();
    console.info(`[IMAP] Connected successfully as ${config.imap.user}`);

    // Reset backoff on successful connection
    reconnectAttempt = 0;
    isRunning = true;

    // ─── Initial Backlog Processing ────────────────────────────────────
    // Process existing unseen emails in batches. If there are thousands
    // of unread emails (e.g. first run on a busy inbox), this prevents
    // the system from trying to ingest them all at once.
    let totalProcessed = 0;
    let batchProcessed;
    do {
      batchProcessed = await processUnseenBatch(client, config.batchSize);
      totalProcessed += batchProcessed;

      // Small delay between batches to prevent CPU/memory spikes
      if (batchProcessed > 0 && !isStopping) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } while (batchProcessed >= config.batchSize && !isStopping);

    if (totalProcessed > 0) {
      console.info(`[IMAP] Backlog complete: ${totalProcessed} email(s) processed`);
    }

    // ─── IDLE Mode (Real-Time Listening) ───────────────────────────────
    // Listen for mailbox changes. When the server notifies us of new mail,
    // we break out of IDLE, process the new messages, and re-enter IDLE.
    while (isRunning && !isStopping) {
      try {
        const lock = await client.getMailboxLock(config.imap.folder);
        try {
          // client.idle() returns when:
          // 1. New mail arrives (EXISTS response from server)
          // 2. The IDLE timeout expires (imapflow handles re-IDLE internally)
          // 3. The connection drops
          await client.idle();
        } finally {
          lock.release();
        }

        // IDLE returned — likely new mail. Process any unseen messages.
        if (!isStopping) {
          console.info('[IMAP] IDLE interrupted — checking for new mail...');
          await processUnseenBatch(client, config.batchSize);
        }
      } catch (idleErr) {
        if (!isStopping) {
          console.warn(`[IMAP] IDLE error: ${idleErr.message}`);
          // Break out to trigger reconnection
          break;
        }
      }
    }
  } catch (connectErr) {
    console.error(`[IMAP] Connection failed: ${connectErr.message}`);
  } finally {
    // Clean up the client
    if (client) {
      try {
        await client.logout();
      } catch {
        // Ignore logout errors — connection may already be dead
      }
      client = null;
    }
  }

  // ─── Reconnect Logic ──────────────────────────────────────────────────
  if (!isStopping) {
    const delay = getReconnectDelay();
    reconnectAttempt++;
    console.info(`[IMAP] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${reconnectAttempt})...`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Starts the IMAP email watcher.
 * Connects to the mail server, processes backlog, and enters IDLE mode.
 * Auto-reconnects on connection failures.
 *
 * @returns {Promise<void>}
 */
async function start() {
  if (isRunning) {
    console.warn('[IMAP] Watcher is already running');
    return;
  }

  isStopping = false;
  reconnectAttempt = 0;
  console.info('[IMAP] Starting email watcher...');

  // Start connection in background — don't await because IDLE runs forever
  connect().catch(err => {
    console.error(`[IMAP] Fatal error: ${err.message}`);
  });
}

/**
 * Gracefully stops the IMAP watcher.
 * Cancels any pending reconnect timers and disconnects the client.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  console.info('[IMAP] Stopping email watcher...');
  isStopping = true;
  isRunning = false;

  // Cancel pending reconnect
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Disconnect the IMAP client
  if (client) {
    try {
      await client.logout();
    } catch {
      // Ignore — connection may already be closed
    }
    client = null;
  }

  console.info('[IMAP] Email watcher stopped');
}

module.exports = { start, stop };
