/**
 * @module services/emailWatcher
 * @description Factory module that selects and manages the correct email watcher
 * based on the EMAIL_PROVIDER environment variable.
 *
 * This is the single entry point for the rest of the application.
 * The app.js startup code only needs to call:
 *   const emailWatcher = require('./services/emailWatcher');
 *   await emailWatcher.start();
 *
 * The factory pattern keeps the provider-specific implementations decoupled
 * from the application lifecycle code. Switching providers is a single
 * .env change — no code modifications required.
 */

const { config, validateConfig } = require('../config/emailConfig');

/** @type {{ start: () => Promise<void>, stop: () => Promise<void> } | null} */
let activeWatcher = null;

/**
 * Starts the email watcher configured by EMAIL_PROVIDER env var.
 * Validates configuration before attempting to start.
 *
 * @returns {Promise<void>}
 * @throws {Error} If EMAIL_PROVIDER is set to an invalid value or required config is missing
 */
async function start() {
  // Validate configuration — throws descriptive errors if misconfigured
  validateConfig();

  if (!config.provider) {
    console.info('[EmailWatcher] EMAIL_PROVIDER not set — email ingestion is disabled');
    return;
  }

  console.info(`[EmailWatcher] Initializing "${config.provider}" provider...`);

  switch (config.provider) {
    case 'imap':
      activeWatcher = require('./emailWatcher.imap');
      break;

    case 'gmail':
      activeWatcher = require('./emailWatcher.gmail');
      break;

    default:
      // validateConfig() should have already caught this, but belt-and-suspenders
      throw new Error(`Unknown EMAIL_PROVIDER: "${config.provider}"`);
  }

  await activeWatcher.start();
  console.info(`[EmailWatcher] "${config.provider}" watcher started successfully`);
}

/**
 * Gracefully stops the active email watcher.
 * Safe to call even if no watcher is running.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  if (activeWatcher) {
    console.info('[EmailWatcher] Stopping active watcher...');
    await activeWatcher.stop();
    activeWatcher = null;
    console.info('[EmailWatcher] Watcher stopped');
  }
}

module.exports = { start, stop };
