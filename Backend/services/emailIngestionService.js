/**
 * @module services/emailIngestionService
 * @description Shared business logic for email attachment ingestion.
 * Used by both IMAP and Gmail watchers. Contains:
 * - Attachment validation (file type, size)
 * - Filename sanitization (path traversal prevention, collision avoidance)
 * - Duplicate detection (via ProcessedEmail collection)
 * - File saving to disk
 * - Document record creation and enrichment queue integration
 * - System bot user management
 *
 * Design principle: All validation/utility functions are pure and exported
 * individually so they can be unit-tested without mocking MongoDB or filesystem.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { config } = require('../config/emailConfig');
const ProcessedEmail = require('../models/processedEmail.model');
const Document = require('../models/document.model');
const Activity = require('../models/activity.model');
const User = require('../models/user.model');
const { createChildLogger } = require('../config/logger');

const logger = createChildLogger('EmailIngestion');

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Directory where email attachments are saved, relative to Backend root.
 * Uses a subdirectory to keep email-ingested files separate from manual uploads.
 */
const EMAIL_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'email');

/**
 * MIME type → extension mapping for attachments that arrive with a MIME type
 * but no filename/extension. Covers the most common document types.
 */
const MIME_TO_EXTENSION = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

// Cached reference to the bot user — populated on first call to getOrCreateBotUser()
let _cachedBotUser = null;

// ─── Pure Utility Functions ──────────────────────────────────────────────────
// These are exported individually and designed to be unit-testable
// without any external dependencies (no DB, no filesystem).

/**
 * Sanitizes a filename to prevent path traversal attacks and filesystem issues.
 * Strips directory components, replaces unsafe characters, and prepends a
 * timestamp + short random ID to guarantee uniqueness.
 *
 * @param {string} rawName - Original filename from the email attachment
 * @returns {string} Safe, unique filename (e.g. "1690300000000_a1b2c3d4_report.pdf")
 *
 * @example
 * sanitizeFilename('../../../etc/passwd')  // "1690300000000_a1b2c3d4_etcpasswd"
 * sanitizeFilename('My Report (Final).pdf') // "1690300000000_a1b2c3d4_My_Report__Final_.pdf"
 * sanitizeFilename('')                      // "1690300000000_a1b2c3d4_attachment"
 */
function sanitizeFilename(rawName) {
  if (!rawName || typeof rawName !== 'string' || rawName.trim() === '') {
    rawName = 'attachment';
  }

  // Step 1: Extract only the basename — strips any directory path components
  // that could be used for path traversal (e.g. "../../../etc/passwd")
  let name = path.basename(rawName);

  // Step 2: Replace characters that are unsafe on Windows/Linux/macOS filesystems
  // Keeps: alphanumeric, dots, hyphens, underscores
  // Step 2a: Extract extension before sanitizing, so it survives unicode stripping.
  // e.g. "文件名.pdf" → ext=".pdf", baseName="文件名"
  let ext = path.extname(name);
  let baseName = name.substring(0, name.length - ext.length);

  // Sanitize extension: only keep safe chars
  ext = ext.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase();

  // Step 2b: Replace characters that are unsafe on Windows/Linux/macOS filesystems
  // Keeps: alphanumeric, dots, hyphens, underscores
  baseName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Step 3: Collapse consecutive underscores/dots for cleanliness
  baseName = baseName.replace(/_{2,}/g, '_').replace(/\.{2,}/g, '.');

  // Step 4: Remove leading dots/dashes (hidden files on Unix, problematic on Windows)
  baseName = baseName.replace(/^[._-]+/, '');

  // Step 5: Remove trailing underscores/dots for cleanliness
  baseName = baseName.replace(/[._-]+$/, '');

  // Step 5b: If stripping removed everything, use fallback name
  if (!baseName || baseName === '') {
    baseName = 'attachment';
  }

  // Reassemble name with extension
  name = ext ? `${baseName}${ext}` : baseName;

  // Step 6: Truncate excessively long names (max 200 chars) to prevent
  // filesystem path length limits (Windows MAX_PATH = 260)
  if (name.length > 200) {
    const truncatedBase = baseName.substring(0, 200 - ext.length);
    name = ext ? `${truncatedBase}${ext}` : truncatedBase;
  }

  // Step 7: Prepend timestamp + short random hex to guarantee uniqueness
  // across concurrent processing and process restarts
  const timestamp = Date.now();
  const randomId = crypto.randomBytes(4).toString('hex');
  return `${timestamp}_${randomId}_${name}`;
}

/**
 * Checks whether a file type is in the allowed list.
 * Tries extension first, falls back to MIME type lookup.
 *
 * @param {string} filename - Attachment filename (may be empty)
 * @param {string} mimeType - MIME type reported by the email parser
 * @returns {boolean} True if the file type is allowed
 *
 * @example
 * isAllowedFileType('report.pdf', 'application/pdf')  // true
 * isAllowedFileType('', 'application/pdf')             // true (MIME fallback)
 * isAllowedFileType('virus.exe', 'application/x-msdownload')  // false
 */
function isAllowedFileType(filename, mimeType) {
  const allowedTypes = config.allowedTypes;

  // Try 1: Check file extension
  if (filename && typeof filename === 'string') {
    const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
    if (ext && allowedTypes.includes(ext)) {
      return true;
    }
  }

  // Try 2: Check MIME type → extension mapping
  if (mimeType && typeof mimeType === 'string') {
    const mimeExt = MIME_TO_EXTENSION[mimeType.toLowerCase()];
    if (mimeExt && allowedTypes.includes(mimeExt)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether an attachment size is within the configured limit.
 *
 * @param {number} sizeBytes - Attachment size in bytes
 * @returns {boolean} True if within limit
 *
 * @example
 * isWithinSizeLimit(1024)          // true (1KB)
 * isWithinSizeLimit(25 * 1024 * 1024)  // false (25MB > 20MB default)
 */
function isWithinSizeLimit(sizeBytes) {
  if (typeof sizeBytes !== 'number' || sizeBytes < 0) return false;
  return sizeBytes <= config.maxAttachmentSizeBytes;
}

/**
 * Resolves a filename for an attachment, handling the case where the email
 * parser reports no filename. Falls back to MIME type mapping.
 *
 * @param {string|null} originalName - Filename from the attachment
 * @param {string|null} mimeType - MIME type from the attachment
 * @returns {string} A usable filename
 */
function resolveFilename(originalName, mimeType) {
  if (originalName && typeof originalName === 'string' && originalName.trim()) {
    return originalName.trim();
  }

  // No filename — try to derive extension from MIME type
  const ext = MIME_TO_EXTENSION[(mimeType || '').toLowerCase()] || 'bin';
  return `attachment.${ext}`;
}

// ─── Database-Dependent Functions ────────────────────────────────────────────

/**
 * Checks whether an email with the given message ID has already been processed.
 * Uses the ProcessedEmail collection for O(1) lookups via the unique index.
 *
 * @param {string} messageId - The email's unique message ID
 * @returns {Promise<boolean>} True if already processed
 */
async function isDuplicate(messageId) {
  if (!messageId) return false;
  const existing = await ProcessedEmail.findOne({ messageId }).lean();
  return !!existing;
}

/**
 * Records an email as processed in the ProcessedEmail collection.
 * Uses upsert to handle race conditions — if two workers somehow process
 * the same email simultaneously, only one record is created.
 *
 * @param {Object} details - Email details
 * @param {string} details.messageId - Unique message ID
 * @param {string} details.source - Provider ("imap" or "gmail")
 * @param {string} details.sender - Sender email address
 * @param {string} details.subject - Email subject line
 * @param {Date} details.receivedAt - When the email was received
 * @param {number} details.attachmentCount - Number of ingested attachments
 * @param {string[]} details.documentIds - Created document ObjectIds
 * @returns {Promise<Object>} The created/updated ProcessedEmail record
 */
async function markAsProcessed(details) {
  return ProcessedEmail.findOneAndUpdate(
    { messageId: details.messageId },
    {
      $set: {
        source: details.source,
        sender: (details.sender || '').substring(0, 500),
        subject: (details.subject || '').substring(0, 500),
        receivedAt: details.receivedAt || new Date(),
        attachmentCount: details.attachmentCount || 0,
        documentIds: details.documentIds || [],
        processedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
}

/**
 * Finds or creates the system bot user that owns email-ingested documents.
 * Caches the result after first lookup to avoid repeated DB queries.
 *
 * Why a bot user: Every Document requires a userId (required field).
 * Email-ingested documents don't come from a logged-in user, so we
 * assign them to a dedicated system account.
 *
 * @returns {Promise<Object>} The bot user document
 */
async function getOrCreateBotUser() {
  // Return cached user if we already looked it up
  if (_cachedBotUser) {
    // Verify the cached user still exists (could have been manually deleted)
    const stillExists = await User.findById(_cachedBotUser._id).lean();
    if (stillExists) return _cachedBotUser;
    _cachedBotUser = null;
  }

  const botUsername = config.botUsername;
  const botEmail = config.botEmail;

  // Try to find existing bot user
  let botUser = await User.findOne({
    $or: [{ username: botUsername }, { email: botEmail }],
  });

  if (!botUser) {
    // Create the bot user with a random password (it never logs in)
    const bcrypt = require('bcrypt');
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    botUser = await User.create({
      username: botUsername,
      email: botEmail,
      password: hashedPassword,
      role: 'admin',
    });

    logger.info(`[EmailIngestion] Created system bot user: ${botUsername} (${botEmail})`);
  }

  _cachedBotUser = botUser;
  return botUser;
}

// ─── File Operations ─────────────────────────────────────────────────────────

/**
 * Ensures the email upload directory exists.
 * Called once on module load and before each save operation.
 */
function ensureUploadDir() {
  fs.mkdirSync(EMAIL_UPLOAD_DIR, { recursive: true });
}

/**
 * Saves an attachment buffer to disk with a sanitized filename.
 *
 * @param {Buffer} buffer - The attachment content
 * @param {string} originalName - Original filename from the email
 * @param {string} mimeType - MIME type of the attachment
 * @returns {Promise<{filePath: string, diskName: string, originalName: string}>}
 *   filePath: Relative path from Backend root (e.g. "uploads/email/16903_a1b2_report.pdf")
 *   diskName: Just the sanitized filename
 *   originalName: The resolved original name
 */
async function saveAttachment(buffer, originalName, mimeType) {
  ensureUploadDir();

  const resolvedName = resolveFilename(originalName, mimeType);
  const diskName = sanitizeFilename(resolvedName);
  const absolutePath = path.join(EMAIL_UPLOAD_DIR, diskName);

  await fs.promises.writeFile(absolutePath, buffer);

  // Return relative path matching the convention used by upload.middleware.js
  const relativePath = path.join('uploads', 'email', diskName).replace(/\\/g, '/');

  return { filePath: relativePath, diskName, originalName: resolvedName };
}

/**
 * Creates a Document record in MongoDB and queues it for AI enrichment.
 * This mirrors the logic in document.controller.js upload handler
 * but adapted for email-sourced documents.
 *
 * @param {Object} params
 * @param {string} params.filePath - Relative file path (e.g. "uploads/email/...")
 * @param {string} params.originalName - Original attachment filename
 * @param {string} params.sender - Sender email address
 * @param {string} params.subject - Email subject line
 * @param {Date} params.receivedAt - When the email was received
 * @returns {Promise<Object>} The created Document record
 */
async function ingestAttachment({ filePath, originalName, sender, subject, receivedAt, fileHash }) {
  const botUser = await getOrCreateBotUser();

  const fileType = path.extname(originalName).replace(/^\./, '').toLowerCase() || 'unknown';

  // Create document record — mirrors document.controller.js upload logic
  const doc = await Document.create({
    userId: botUser._id,
    fileName: originalName,
    fileType,
    fileHash,
    filePath,
    extractedText: '',
    summary: '',
    keywords: [],
    status: 'processing',
  });

  // Log the ingestion activity
  await Activity.create({
    user: botUser._id,
    action: 'Email ingestion: document received',
    entityType: 'Document',
    entityName: doc.fileName,
    comment: `From: ${(sender || 'unknown').substring(0, 200)} | Subject: ${(subject || '').substring(0, 200)} | Received: ${receivedAt || 'unknown'}`,
  });

  // Queue for AI enrichment — uses the same in-memory queue as manual uploads
  // We require this lazily to avoid circular dependency issues
  const { queueDocumentEnrichment } = require('../controllers/document.controller');
  const absolutePath = path.join(__dirname, '..', filePath);
  queueDocumentEnrichment(doc._id, absolutePath, originalName);

  logger.info(`[EmailIngestion] Ingested: "${originalName}" (${fileType}) from ${sender || 'unknown'} → Document ${doc._id}`);

  return doc;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Processes a single email: validates, deduplicates, saves attachments,
 * and ingests each valid attachment into the document pipeline.
 *
 * This is the main entry point called by both IMAP and Gmail watchers.
 *
 * @param {Object} email - Parsed email object
 * @param {string} email.messageId - Unique message ID
 * @param {string} email.sender - Sender email address
 * @param {string} email.subject - Email subject
 * @param {Date} email.receivedAt - When received
 * @param {string} email.source - "imap" or "gmail"
 * @param {Array<Object>} email.attachments - Array of attachment objects
 * @param {string} email.attachments[].filename - Attachment filename
 * @param {string} email.attachments[].mimeType - MIME type
 * @param {number} email.attachments[].size - Size in bytes
 * @param {Buffer} email.attachments[].content - Raw attachment content
 * @returns {Promise<{processed: boolean, documentIds: string[], skipped: number, errors: number}>}
 */
async function processEmail(email) {
  const result = { processed: false, documentIds: [], skipped: 0, errors: 0 };

  const logPrefix = `[EmailIngestion][${email.source}]`;

  // ─── Step 1: Dedup Check ─────────────────────────────────────────────
  if (!email.messageId) {
    logger.warn(`${logPrefix} Email has no messageId — skipping to prevent untrackable duplicates`);
    return result;
  }

  if (await isDuplicate(email.messageId)) {
    logger.info(`${logPrefix} Already processed messageId="${email.messageId}" — skipping`);
    result.processed = true; // Already handled
    return result;
  }

  // ─── Step 2: Validate Attachments Exist ──────────────────────────────
  if (!email.attachments || email.attachments.length === 0) {
    logger.info(`${logPrefix} No attachments in email from ${email.sender || 'unknown'} — skipping`);
    // Still mark as processed so we don't re-check it
    await markAsProcessed({
      messageId: email.messageId,
      source: email.source,
      sender: email.sender,
      subject: email.subject,
      receivedAt: email.receivedAt,
      attachmentCount: 0,
      documentIds: [],
    });
    result.processed = true;
    return result;
  }

  logger.info(`${logPrefix} Processing email from ${email.sender || 'unknown'} | Subject: "${(email.subject || '').substring(0, 100)}" | ${email.attachments.length} attachment(s)`);

  // ─── Step 3: Process Each Attachment ─────────────────────────────────
  for (const attachment of email.attachments) {
    try {
      const resolvedName = resolveFilename(attachment.filename, attachment.mimeType);

      // Validate file type
      if (!isAllowedFileType(resolvedName, attachment.mimeType)) {
        logger.warn(`${logPrefix} Skipping attachment "${resolvedName}" — file type not allowed`);
        result.skipped++;
        continue;
      }

      // Validate file size
      const size = attachment.size || (attachment.content ? attachment.content.length : 0);
      if (!isWithinSizeLimit(size)) {
        logger.warn(
          `${logPrefix} Skipping attachment "${resolvedName}" — ` +
          `size ${(size / 1024 / 1024).toFixed(2)}MB exceeds limit of ${config.maxAttachmentSizeMB}MB`
        );
        result.skipped++;
        continue;
      }

      // Validate content exists
      if (!attachment.content || attachment.content.length === 0) {
        logger.warn(`${logPrefix} Skipping attachment "${resolvedName}" — empty content`);
        result.skipped++;
        continue;
      }

      // Check for duplicate file content using SHA-256 hash
      const fileHash = crypto.createHash('sha256').update(attachment.content).digest('hex');
      const existingDoc = await Document.findOne({ fileHash });

      if (existingDoc) {
        logger.warn(`${logPrefix} Skipping attachment "${resolvedName}" — duplicate file detected (hash match)`);
        
        const botUser = await getOrCreateBotUser();
        await Activity.create({
          user: botUser._id,
          action: 'Email ingestion: duplicate blocked',
          entityType: 'Document',
          entityName: resolvedName,
          comment: `From: ${(email.sender || 'unknown').substring(0, 200)} | Blocked identical file: ${existingDoc.fileName}`
        });

        result.skipped++;
        continue;
      }

      // Save to disk
      const saved = await saveAttachment(attachment.content, attachment.filename, attachment.mimeType);

      // Create document and queue enrichment
      const doc = await ingestAttachment({
        filePath: saved.filePath,
        originalName: saved.originalName,
        sender: email.sender,
        subject: email.subject,
        receivedAt: email.receivedAt,
        fileHash,
      });

      result.documentIds.push(doc._id.toString());
    } catch (err) {
      // Individual attachment failure should NOT stop processing the rest
      logger.error(
        `${logPrefix} Failed to process attachment "${attachment.filename || 'unnamed'}": ${err.message}`
      );
      result.errors++;
    }
  }

  // ─── Step 4: Mark Email as Processed ─────────────────────────────────
  await markAsProcessed({
    messageId: email.messageId,
    source: email.source,
    sender: email.sender,
    subject: email.subject,
    receivedAt: email.receivedAt,
    attachmentCount: result.documentIds.length,
    documentIds: result.documentIds,
  });

  result.processed = true;

  logger.info(
    `${logPrefix} Done: ${result.documentIds.length} ingested, ${result.skipped} skipped, ${result.errors} errors`
  );

  return result;
}

// ─── Ensure upload directory exists on module load ───────────────────────────
ensureUploadDir();

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  // Pure functions (unit-testable without mocks)
  sanitizeFilename,
  isAllowedFileType,
  isWithinSizeLimit,
  resolveFilename,

  // Database-dependent functions
  isDuplicate,
  markAsProcessed,
  getOrCreateBotUser,

  // File + ingestion operations
  saveAttachment,
  ingestAttachment,

  // Main orchestrator
  processEmail,

  // Constants (for testing)
  EMAIL_UPLOAD_DIR,
  MIME_TO_EXTENSION,
};
