/**
 * @module config/emailConfig
 * @description Centralized configuration for the email ingestion module.
 * Reads all email-related environment variables, validates required ones
 * based on the selected provider mode, and exports a frozen config object.
 *
 * Why a dedicated config module: Keeps validation in one place so watchers
 * and services don't each independently parse env vars. Also makes it easy
 * to swap config sources (e.g. Vault, SSM) later without touching business logic.
 */

require('dotenv').config();

/**
 * Parses comma-separated string into a trimmed, lowercased array.
 * @param {string} envValue - Raw env var value (e.g. "pdf,docx,png")
 * @param {string[]} fallback - Default array if envValue is empty
 * @returns {string[]}
 */
function parseCommaSeparatedList(envValue, fallback) {
  if (!envValue || envValue.trim() === '') return fallback;
  return envValue
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Safely parses an integer from an env var, falling back to a default.
 * @param {string} envValue - Raw env var value
 * @param {number} fallback - Default value
 * @returns {number}
 */
function parseIntSafe(envValue, fallback) {
  const parsed = parseInt(envValue, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// ─── Default Allowed File Types ──────────────────────────────────────────────
// These match the extensions already accepted by the upload middleware,
// ensuring consistency between manual uploads and email ingestion.
const DEFAULT_ALLOWED_TYPES = [
  'pdf', 'docx', 'doc', 'png', 'jpg', 'jpeg',
  'xlsx', 'xls', 'csv', 'txt', 'gif', 'webp',
  'md', 'html', 'htm', 'json', 'xml', 'log'
];

// ─── Build Configuration Object ─────────────────────────────────────────────
const config = {
  // Which email provider to use: "imap" | "gmail" | "" (disabled)
  provider: (process.env.EMAIL_PROVIDER || '').toLowerCase().trim(),

  // ─── IMAP Settings ──────────────────────────────────────────────────────
  imap: {
    host: process.env.IMAP_HOST || '',
    port: parseIntSafe(process.env.IMAP_PORT, 993),
    user: process.env.IMAP_USER || '',
    password: process.env.IMAP_PASSWORD || '',
    tls: process.env.IMAP_TLS !== 'false', // Default true; only false if explicitly set
    folder: process.env.IMAP_FOLDER || 'INBOX',
  },

  // ─── Gmail API Settings ─────────────────────────────────────────────────
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/auth/gmail/callback',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    userEmail: process.env.GMAIL_USER_EMAIL || 'me',
  },

  // ─── Shared Settings ────────────────────────────────────────────────────
  allowedTypes: parseCommaSeparatedList(
    process.env.EMAIL_ALLOWED_TYPES,
    DEFAULT_ALLOWED_TYPES
  ),
  maxAttachmentSizeMB: parseIntSafe(process.env.EMAIL_MAX_ATTACHMENT_SIZE_MB, 20),
  batchSize: parseIntSafe(process.env.EMAIL_BATCH_SIZE, 10),
  pollIntervalMs: parseIntSafe(process.env.EMAIL_POLL_INTERVAL_MS, 60000),
  processedTtlDays: parseIntSafe(process.env.EMAIL_PROCESSED_TTL_DAYS, 90),
  botUsername: process.env.EMAIL_BOT_USERNAME || 'email-bot',
  botEmail: process.env.EMAIL_BOT_EMAIL || 'email-bot@system.local',

  /** Maximum attachment size in bytes (derived from MB setting) */
  get maxAttachmentSizeBytes() {
    return this.maxAttachmentSizeMB * 1024 * 1024;
  },
};

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validates that all required configuration for the selected provider is present.
 * Throws a descriptive error if any required vars are missing.
 * @throws {Error} If required configuration is missing
 */
function validateConfig() {
  if (!config.provider) {
    // Email ingestion is disabled — nothing to validate
    return;
  }

  if (config.provider === 'imap') {
    const required = { IMAP_HOST: config.imap.host, IMAP_USER: config.imap.user, IMAP_PASSWORD: config.imap.password };
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(
        `IMAP mode requires these environment variables: ${missing.join(', ')}. ` +
        'See .env.example for details.'
      );
    }
  } else if (config.provider === 'gmail') {
    const required = {
      GMAIL_CLIENT_ID: config.gmail.clientId,
      GMAIL_CLIENT_SECRET: config.gmail.clientSecret,
      GMAIL_REFRESH_TOKEN: config.gmail.refreshToken,
    };
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(
        `Gmail API mode requires these environment variables: ${missing.join(', ')}. ` +
        'See .env.example for details.'
      );
    }
  } else {
    throw new Error(
      `Invalid EMAIL_PROVIDER "${config.provider}". Must be "imap" or "gmail".`
    );
  }
}

module.exports = { config, validateConfig, parseCommaSeparatedList, parseIntSafe };
