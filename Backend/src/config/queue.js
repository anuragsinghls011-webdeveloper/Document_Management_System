/**
 * @fileoverview Shared BullMQ queue definitions and Redis connection config.
 *
 * All workflow queues share the same Redis connection settings.
 * Connection config is driven by environment variables:
 * - REDIS_HOST (default: 127.0.0.1)
 * - REDIS_PORT (default: 6379)
 * - REDIS_PASSWORD (default: empty)
 *
 * @module config/queue
 */

const { Queue } = require('bullmq');

/**
 * Redis connection options shared by all queues and workers.
 * Workers import this to create their own connections (BullMQ requires
 * separate connections for Queue and Worker instances).
 */
const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null // Required by BullMQ
};

/**
 * Queue for newly-classified documents awaiting routing.
 * The routing worker consumes jobs from this queue.
 */
const routingQueue = new Queue('document-routing', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000 // 2s, 4s, 8s
    },
    removeOnComplete: { count: 1000 }, // Keep last 1000 completed for debugging
    removeOnFail: { count: 5000 }
  }
});

/**
 * Queue for SLA escalation checks.
 * Jobs are added with a delay (the SLA window). When the delay expires,
 * the escalation worker picks up the job and checks whether the approver
 * has acted.
 */
const escalationQueue = new Queue('document-escalation', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 3000
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 }
  }
});

/**
 * Queue for notifications (approver assignment, escalation alerts, etc.).
 * This module only exposes the queue for adding jobs — no worker is
 * implemented here. The notification delivery system is assumed to exist
 * elsewhere and will consume from this queue.
 */
const notifyQueue = new Queue('notifications', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 }
  }
});

module.exports = {
  redisConnection,
  routingQueue,
  escalationQueue,
  notifyQueue
};
