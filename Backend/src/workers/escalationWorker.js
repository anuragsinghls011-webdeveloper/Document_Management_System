/**
 * @fileoverview BullMQ worker that handles SLA-based escalation.
 *
 * FLOW:
 * 1. A delayed job fires after the SLA window expires
 * 2. Fetch the document and check if it still needs escalation
 * 3. If the document was already resolved (approved/rejected), no-op
 * 4. If the escalation job ID doesn't match, it's stale — no-op
 * 5. If the chain has a next step, advance to the next approver
 * 6. If the chain is exhausted, mark as needs_review
 *
 * STALE-JOB DETECTION:
 * When a document is approved/rejected, the escalationJobId on the doc
 * is cleared. When the delayed escalation job finally fires, it checks
 * doc.escalationJobId !== job.id → no-op. This prevents escalation of
 * already-resolved documents.
 *
 * Similarly, when an approval advances the chain and schedules a NEW
 * escalation job, the old job's ID no longer matches → stale → no-op.
 *
 * @module workers/escalationWorker
 */

const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const Document = require('../../models/document.model');
const { resolveApprover } = require('../services/approverResolver');
const { redisConnection, escalationQueue, notifyQueue } = require('../config/queue');
const { createChildLogger } = require('../../config/logger');

const logger = createChildLogger('EscalationWorker');

/** SLA window in milliseconds. Used for scheduling the next escalation. */
const ESCALATION_SLA_MS = parseInt(process.env.ESCALATION_SLA_MS, 10) || 48 * 60 * 60 * 1000;

/**
 * Process a single escalation check job.
 *
 * @param {import('bullmq').Job} job
 * @param {Object} job.data
 * @param {string} job.data.documentId - MongoDB _id of the document
 * @param {number} job.data.expectedStep - The approval step this escalation was scheduled for
 * @param {number} job.data.chainLength - Total length of the approval chain
 */
async function processEscalationJob(job) {
  const { documentId, expectedStep, chainLength } = job.data;
  const logPrefix = `[EscalationWorker][${job.id}][doc:${documentId}]`;

  logger.info(`${logPrefix} Checking escalation for step ${expectedStep}`);

  // ── Step 1: Fetch document ────────────────────────────────────────────────
  const doc = await Document.findById(documentId);
  if (!doc) {
    logger.warn(`${logPrefix} Document not found — skipping`);
    return;
  }

  // ── Step 2: Stale-job guard ───────────────────────────────────────────────
  // If the document is no longer pending_approval, it was already resolved.
  // No action needed.
  if (doc.status !== 'pending_approval') {
    logger.info(`${logPrefix} Document status is "${doc.status}" (not pending_approval) — stale job, skipping`);
    return;
  }

  // If the escalation job ID on the doc doesn't match this job, a newer
  // escalation was scheduled (e.g., after a chain advancement). This job
  // is stale.
  if (doc.escalationJobId && doc.escalationJobId !== job.id) {
    logger.info(`${logPrefix} Escalation job ID mismatch (doc has "${doc.escalationJobId}", this is "${job.id}") — stale job, skipping`);
    return;
  }

  // If the approval step has already advanced past what this job expected,
  // another action already moved the chain forward.
  if (doc.approvalStep !== expectedStep) {
    logger.info(`${logPrefix} Step mismatch (doc at step ${doc.approvalStep}, expected ${expectedStep}) — stale job, skipping`);
    return;
  }

  // ── Step 3: Determine next action ─────────────────────────────────────────
  const nextStep = expectedStep + 1;
  const currentChainEntry = doc.approvalChain[expectedStep];

  if (nextStep < chainLength && nextStep < doc.approvalChain.length) {
    // ── Case A: Advance to next approver in the chain ───────────────────────
    const nextChainEntry = doc.approvalChain[nextStep];

    logger.info(`${logPrefix} SLA expired for step ${expectedStep} (${currentChainEntry.role}). Escalating to step ${nextStep} (${nextChainEntry.role})`);

    // Atomically update: mark current step as escalated, advance to next
    const updatedDoc = await Document.findOneAndUpdate(
      {
        _id: documentId,
        status: 'pending_approval',
        approvalStep: expectedStep // Concurrency guard
      },
      {
        $set: {
          approvalStep: nextStep,
          currentApprover: nextChainEntry.userId,
          [`approvalChain.${expectedStep}.status`]: 'escalated',
          [`approvalChain.${expectedStep}.actedAt`]: new Date()
        },
        $push: {
          history: {
            status: 'escalated',
            actor: 'system',
            note: `SLA expired for ${currentChainEntry.role} (${currentChainEntry.userId}). Escalated to ${nextChainEntry.role} (${nextChainEntry.userId})`,
            timestamp: new Date()
          }
        }
      },
      { new: true }
    );

    if (!updatedDoc) {
      logger.info(`${logPrefix} Concurrent update detected — another process already handled this`);
      return;
    }

    // Notify the next approver
    try {
      await notifyQueue.add('escalation-notification', {
        type: 'escalation',
        documentId: documentId.toString(),
        approverId: nextChainEntry.userId.toString(),
        approverRole: nextChainEntry.role,
        documentName: doc.fileName,
        previousApproverRole: currentChainEntry.role,
        step: nextStep,
        totalSteps: chainLength
      });
    } catch (err) {
      logger.error(`${logPrefix} Failed to queue escalation notification:`, err.message);
    }

    // Schedule next escalation check for the new approver
    try {
      const newEscalationJob = await escalationQueue.add(
        'check-escalation',
        {
          documentId: documentId.toString(),
          expectedStep: nextStep,
          chainLength
        },
        {
          delay: ESCALATION_SLA_MS,
          jobId: `escalation-${documentId}-step-${nextStep}-${Date.now()}`
        }
      );

      await Document.findByIdAndUpdate(documentId, {
        escalationJobId: newEscalationJob.id
      });

      logger.info(`${logPrefix} Next escalation scheduled (jobId: ${newEscalationJob.id})`);
    } catch (err) {
      logger.error(`${logPrefix} Failed to schedule next escalation:`, err.message);
    }

  } else {
    // ── Case B: Chain exhausted — mark as needs_review ──────────────────────
    // All approvers in the chain have missed their SLA. The document
    // cannot remain in pending_approval forever — move to needs_review
    // for manual intervention.

    logger.info(`${logPrefix} Escalation chain exhausted (last approver: ${currentChainEntry.role}). Moving to needs_review`);

    const updatedDoc = await Document.findOneAndUpdate(
      {
        _id: documentId,
        status: 'pending_approval',
        approvalStep: expectedStep
      },
      {
        $set: {
          status: 'needs_review',
          [`approvalChain.${expectedStep}.status`]: 'escalated',
          [`approvalChain.${expectedStep}.actedAt`]: new Date(),
          escalationJobId: null
        },
        $push: {
          history: {
            status: 'needs_review',
            actor: 'system',
            note: `Escalation chain exhausted. Last approver ${currentChainEntry.role} (${currentChainEntry.userId}) did not act within SLA. Document requires manual review.`,
            timestamp: new Date()
          }
        }
      },
      { new: true }
    );

    if (!updatedDoc) {
      logger.info(`${logPrefix} Concurrent update — another process already handled this`);
      return;
    }

    // Notify admins that manual review is needed
    try {
      await notifyQueue.add('needs-review-notification', {
        type: 'needs_review',
        documentId: documentId.toString(),
        documentName: doc.fileName,
        reason: 'Escalation chain exhausted — all approvers missed SLA'
      });
    } catch (err) {
      logger.error(`${logPrefix} Failed to queue needs_review notification:`, err.message);
    }
  }
}

/**
 * Create and start the escalation worker.
 *
 * @returns {import('bullmq').Worker} The running worker instance
 */
function startEscalationWorker() {
  const worker = new Worker('document-escalation', processEscalationJob, {
    connection: redisConnection,
    concurrency: 3
  });

  worker.on('completed', (job) => {
    logger.info(`[EscalationWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[EscalationWorker] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    logger.error('[EscalationWorker] Worker error:', err.message);
  });

  logger.info('[EscalationWorker] Started and listening for jobs');
  return worker;
}

module.exports = { startEscalationWorker, processEscalationJob };
