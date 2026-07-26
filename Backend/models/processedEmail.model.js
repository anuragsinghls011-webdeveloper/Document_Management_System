/**
 * @module models/processedEmail
 * @description Mongoose schema for tracking processed email message IDs.
 * This is the backbone of the idempotency guarantee: before ingesting any
 * email, we check this collection. If the messageId already exists, we
 * skip re-processing.
 *
 * Why a dedicated collection instead of checking the Document model:
 * - An email might have zero valid attachments (all too large, wrong type) — 
 *   we still need to record it as "processed" so we don't re-check it.
 * - Decouples email tracking from document lifecycle (documents can be
 *   deleted without re-triggering ingestion).
 * - TTL index auto-cleans old records to prevent unbounded growth.
 */

const mongoose = require('mongoose');

const processedEmailSchema = new mongoose.Schema(
  {
    /**
     * Unique identifier for the email message.
     * For IMAP: This is the RFC 822 Message-ID header (e.g. "<abc123@mail.gmail.com>")
     * For Gmail API: This is the Gmail message ID (e.g. "18a1b2c3d4e5f6g7")
     *
     * Indexed as unique to enforce idempotency at the database level,
     * so even concurrent workers cannot create duplicate records.
     */
    messageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    /**
     * Which provider processed this email.
     * Useful for debugging and auditing when both providers
     * might be tested against the same mailbox.
     */
    source: {
      type: String,
      enum: ['imap', 'gmail'],
      required: true,
    },

    /** Sender's email address (e.g. "alice@example.com") */
    sender: {
      type: String,
      default: '',
    },

    /** Email subject line — truncated to 500 chars for safety */
    subject: {
      type: String,
      default: '',
      maxlength: 500,
    },

    /** When the email was originally received by the mail server */
    receivedAt: {
      type: Date,
    },

    /** Number of attachments that were successfully ingested from this email */
    attachmentCount: {
      type: Number,
      default: 0,
    },

    /**
     * Array of Document IDs created from this email's attachments.
     * Enables tracing from a processed email record back to the documents it produced.
     */
    documentIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Document',
    }],

    /** When this record was created (i.e. when we processed the email) */
    processedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * TTL index: automatically delete processed email records after N days.
 * This prevents the collection from growing unboundedly over months/years.
 * The TTL value is set at schema level; the actual duration is controlled
 * by EMAIL_PROCESSED_TTL_DAYS in the environment (default: 90 days).
 *
 * Note: MongoDB's TTL monitor runs every 60 seconds, so deletion is
 * not instantaneous but eventual. This is fine for a cleanup mechanism.
 */
processedEmailSchema.index(
  { processedAt: 1 },
  {
    expireAfterSeconds: (parseInt(process.env.EMAIL_PROCESSED_TTL_DAYS, 10) || 90) * 24 * 60 * 60,
    name: 'processedEmail_ttl',
  }
);

// Compound index for efficient lookups by source + date range (monitoring queries)
processedEmailSchema.index({ source: 1, processedAt: -1 });

module.exports = mongoose.model('ProcessedEmail', processedEmailSchema);
