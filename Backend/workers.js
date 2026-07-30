/**
 * @fileoverview Standalone worker process entry point.
 *
 * Run this separately from the main API server to offload heavy background
 * tasks (OCR, AI analysis, routing, escalation) to dedicated machines.
 *
 * USAGE:
 *   node workers.js          # Start all workers
 *   npm run workers          # Same, via package.json script
 *
 * REQUIREMENTS:
 *   - MongoDB connection (MONGO_URI)
 *   - Redis connection (REDIS_HOST)
 *   - All the same .env variables as the main server
 *
 * This process does NOT start Express or listen on any HTTP port.
 * It only connects to MongoDB and Redis, then starts the BullMQ workers.
 *
 * For simple deployments, workers run inside app.js (default behavior).
 * Use this file when you need horizontal scaling — run multiple worker
 * instances on separate servers to distribute the processing load.
 *
 * @module workers
 */

require('dotenv').config();

const connectDB = require('./config/db');
const { createChildLogger } = require('./config/logger');

const logger = createChildLogger('WorkerProcess');

// ─── Validate Required Config ────────────────────────────────────────────────

function validateConfig() {
  const required = ['MONGO_URI', 'REDIS_HOST'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  validateConfig();

  logger.info('Starting standalone worker process...');

  // Connect to MongoDB (required for all workers to read/write documents)
  await connectDB();

  // Import and start all workers
  const { startEnrichmentWorker } = require('./src/workers/enrichmentWorker');
  const { startRoutingWorker } = require('./src/workers/routingWorker');
  const { startEscalationWorker } = require('./src/workers/escalationWorker');

  const enrichmentWorker = startEnrichmentWorker();
  const routingWorker = startRoutingWorker();
  const escalationWorker = startEscalationWorker();

  logger.info('All workers started successfully. Waiting for jobs...');

  // ─── Graceful Shutdown ───────────────────────────────────────────────────

  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down workers...`);

    try {
      await Promise.allSettled([
        enrichmentWorker.close(),
        routingWorker.close(),
        escalationWorker.close()
      ]);
      logger.info('All workers stopped gracefully');
    } catch (err) {
      logger.error('Error during worker shutdown', { error: err.message });
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Worker process failed to start', { error: err.message, stack: err.stack });
  process.exit(1);
});
