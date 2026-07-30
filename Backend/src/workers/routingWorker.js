/**
 * @fileoverview BullMQ worker that routes newly-classified documents.
 *
 * FLOW:
 * 1. A job arrives with { documentId, routingVersion }
 * 2. Fetch the document from MongoDB
 * 3. Idempotency check: if doc.routingVersion >= job's version, no-op
 * 4. Call determineRoute(doc) to evaluate rules
 * 5. Resolve each role in the chain to a real userId
 * 6. Atomically update the document with the chain, current approver, status
 * 7. Append history entry
 * 8. Notify the first approver
 * 9. Schedule an escalation check
 *
 * RETRY SAFETY:
 * The routingVersion check ensures that if BullMQ retries a failed job,
 * a document that was already successfully routed won't be re-routed or
 * get duplicate history entries.
 *
 * @module workers/routingWorker
 */

const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const Document = require('../../models/document.model');
const { determineRoute } = require('../services/routingEngine');
const { resolveApprover } = require('../services/approverResolver');
const { redisConnection, escalationQueue, notifyQueue } = require('../config/queue');
const { createChildLogger } = require('../../config/logger');

const logger = createChildLogger('RoutingWorker');

/** SLA window in milliseconds. Default: 48 hours. */
const ESCALATION_SLA_MS = parseInt(process.env.ESCALATION_SLA_MS, 10) || 48 * 60 * 60 * 1000;

/**
 * Process a single routing job.
 *
 * @param {import('bullmq').Job} job
 * @param {Object} job.data
 * @param {string} job.data.documentId - MongoDB _id of the document
 * @param {number} job.data.routingVersion - Expected routing version for idempotency
 */
async function processRoutingJob(job) {
  const { documentId, routingVersion } = job.data;
  const logPrefix = `[RoutingWorker][${job.id}][doc:${documentId}]`;

  logger.info(`${logPrefix} Processing routing job`);

  // ── Step 1: Fetch document ────────────────────────────────────────────────
  const doc = await Document.findById(documentId);
  if (!doc) {
    logger.warn(`${logPrefix} Document not found — skipping`);
    return;
  }

  // ── Step 2: Idempotency check ─────────────────────────────────────────────
  // If the document has already been routed (version incremented), this is
  // a retry of an already-successful job. Skip to avoid duplicates.
  if (doc.routingVersion >= (routingVersion || 1)) {
    logger.info(`${logPrefix} Already routed (version ${doc.routingVersion} >= ${routingVersion}) — skipping`);
    return;
  }

  // ── Step 3: Evaluate routing rules ────────────────────────────────────────
  let routeResult;
  try {
    routeResult = await determineRoute(doc);
    logger.info(`${logPrefix} Rule matched: "${routeResult.ruleName}" (priority ${routeResult.priority}), chain: [${routeResult.chain.join(' → ')}]`);
  } catch (err) {
    logger.error(`${logPrefix} Rule evaluation failed:`, err.message);
    // Route to needs_review so the document isn't left in limbo
    await Document.findByIdAndUpdate(documentId, {
      status: 'needs_review',
      $push: {
        history: {
          status: 'needs_review',
          actor: 'system',
          note: `Routing failed: ${err.message}`,
          timestamp: new Date()
        }
      }
    });
    return;
  }

  // ── Step 4: Resolve approvers ─────────────────────────────────────────────
  const approvalChain = [];
  for (const role of routeResult.chain) {
    const userId = await resolveApprover(role);
    if (!userId) {
      logger.error(`${logPrefix} Could not resolve approver for role "${role}" — routing to needs_review`);
      await Document.findByIdAndUpdate(documentId, {
        status: 'needs_review',
        $push: {
          history: {
            status: 'needs_review',
            actor: 'system',
            note: `Could not resolve approver for role: ${role}`,
            timestamp: new Date()
          }
        }
      });
      return;
    }

    approvalChain.push({
      role,
      userId: new mongoose.Types.ObjectId(userId),
      status: 'pending'
    });
  }

  const firstApprover = approvalChain[0];

  // ── Step 5: Atomically update document ────────────────────────────────────
  // Uses findOneAndUpdate with a version precondition to prevent double-routing
  // if two workers somehow process the same job concurrently.
  const updatedDoc = await Document.findOneAndUpdate(
    {
      _id: documentId,
      routingVersion: { $lt: routingVersion || 1 } // Only update if not already routed
    },
    {
      $set: {
        status: 'pending_approval',
        approvalChain,
        approvalStep: 0,
        currentApprover: firstApprover.userId,
        routingVersion: routingVersion || 1
      },
      $push: {
        history: {
          status: 'routed',
          actor: 'system',
          note: `Routed via rule: "${routeResult.ruleName}" (priority ${routeResult.priority}). Chain: [${routeResult.chain.join(' → ')}]`,
          timestamp: new Date()
        }
      }
    },
    { new: true }
  );

  if (!updatedDoc) {
    logger.info(`${logPrefix} Document was already routed by another worker — skipping`);
    return;
  }

  console.log(`${logPrefix} Document routed successfully. Current approver: ${firstApprover.userId} (${firstApprover.role})`);

  // ── Step 6: Notify first approver ─────────────────────────────────────────
  try {
    await notifyQueue.add('approver-assigned', {
      type: 'approver_assigned',
      documentId: documentId.toString(),
      approverId: firstApprover.userId.toString(),
      approverRole: firstApprover.role,
      documentName: updatedDoc.fileName,
      step: 0,
      totalSteps: approvalChain.length
    });
    logger.info(`${logPrefix} Notification queued for approver ${firstApprover.userId}`);
  } catch (err) {
    // Notification failure is non-fatal — the approval still works
    logger.error(`${logPrefix} Failed to queue notification:`, err.message);
  }

  // ── Step 7: Schedule escalation check ─────────────────────────────────────
  try {
    const escalationJob = await escalationQueue.add(
      'check-escalation',
      {
        documentId: documentId.toString(),
        expectedStep: 0,
        chainLength: approvalChain.length
      },
      {
        delay: ESCALATION_SLA_MS,
        jobId: `escalation-${documentId}-step-0-${Date.now()}`
      }
    );

    // Store the escalation job ID on the document so the escalation worker
    // can detect stale jobs (e.g., if the doc was approved before the job fires).
    await Document.findByIdAndUpdate(documentId, {
      escalationJobId: escalationJob.id
    });

    logger.info(`${logPrefix} Escalation check scheduled (delay: ${ESCALATION_SLA_MS}ms, jobId: ${escalationJob.id})`);
  } catch (err) {
    logger.error(`${logPrefix} Failed to schedule escalation:`, err.message);
  }
}

/**
 * Create and start the routing worker.
 * Call this from the main server startup or run as a separate process.
 *
 * @returns {import('bullmq').Worker} The running worker instance
 */
function startRoutingWorker() {
  const worker = new Worker('document-routing', processRoutingJob, {
    connection: redisConnection,
    concurrency: 5, // Process up to 5 routing jobs in parallel
    limiter: {
      max: 20,
      duration: 1000 // Max 20 jobs per second
    }
  });

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    logger.error(`Worker error: ${err.message}`);
  });

  logger.info('Routing worker started and listening for jobs');
  return worker;
}

module.exports = { startRoutingWorker, processRoutingJob };
