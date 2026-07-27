/**
 * @fileoverview Express routes for the workflow approval engine.
 *
 * Endpoints:
 * - POST /documents/:id/approve — approve the current step
 * - POST /documents/:id/reject  — reject and stop the chain
 * - GET  /documents/:id/history — view the immutable audit trail
 *
 * CONCURRENCY SAFETY:
 * ───────────────────
 * Both approve and reject use `findOneAndUpdate` with a filter that includes
 * the expected currentApprover and status. This means:
 *
 * - If two users call approve simultaneously, only one will match the filter
 *   (the one that runs first). The other gets a 409 Conflict.
 * - If an approve races with an escalation worker, the atomic update ensures
 *   only one wins. The loser detects the mismatch and returns gracefully.
 *
 * This pattern avoids the classic read-then-write race condition where:
 *   1. Thread A reads doc (step=0)
 *   2. Thread B reads doc (step=0)
 *   3. Thread A writes doc (step=1)
 *   4. Thread B writes doc (step=1 again!) ← BUG
 *
 * With findOneAndUpdate + filter, step 4 would find no matching doc and fail
 * atomically.
 *
 * @module routes/workflowRoutes
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const auth = require('../../middlewares/auth.middleware');
const Document = require('../../models/document.model');
const { escalationQueue, notifyQueue } = require('../config/queue');

/** SLA window in milliseconds. */
const ESCALATION_SLA_MS = parseInt(process.env.ESCALATION_SLA_MS, 10) || 48 * 60 * 60 * 1000;

// All workflow routes require authentication
router.use(auth);

/**
 * POST /documents/:id/approve
 *
 * Approve the current step in the document's approval chain.
 * The requester MUST be the document's currentApprover — otherwise 403.
 *
 * If more steps remain in the chain → advances to the next approver.
 * If this is the final step → marks the document as 'approved'.
 *
 * @param {string} req.params.id - Document ID
 * @param {string} [req.body.note] - Optional approval note
 */
router.post('/documents/:id/approve', async (req, res) => {
  try {
    const documentId = req.params.id;
    const userId = req.user.id;
    const { note } = req.body;

    if (!mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({ success: false, message: 'Invalid document ID' });
    }

    // Fetch the document to check authorization and determine next step
    const doc = await Document.findById(documentId);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    if (doc.status !== 'pending_approval') {
      return res.status(400).json({
        success: false,
        message: `Document is not pending approval (current status: ${doc.status})`
      });
    }

    // Authorization: only the current approver can approve
    if (!doc.currentApprover || doc.currentApprover.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You are not the current assigned approver for this document'
      });
    }

    const currentStep = doc.approvalStep;
    const nextStep = currentStep + 1;
    const isLastStep = nextStep >= doc.approvalChain.length;

    if (isLastStep) {
      // ── Final approval — mark document as approved ──────────────────────────
      const updatedDoc = await Document.findOneAndUpdate(
        {
          _id: documentId,
          status: 'pending_approval',
          currentApprover: new mongoose.Types.ObjectId(userId),
          approvalStep: currentStep
        },
        {
          $set: {
            status: 'approved',
            approvedBy: new mongoose.Types.ObjectId(userId),
            approvedAt: new Date(),
            [`approvalChain.${currentStep}.status`]: 'approved',
            [`approvalChain.${currentStep}.actedAt`]: new Date(),
            currentApprover: null,
            escalationJobId: null // Cancel pending escalation reference
          },
          $push: {
            history: {
              status: 'approved',
              actor: userId,
              note: note || `Final approval (step ${currentStep + 1}/${doc.approvalChain.length})`,
              timestamp: new Date()
            }
          }
        },
        { new: true }
      );

      if (!updatedDoc) {
        // Another concurrent request already processed this — return 409
        return res.status(409).json({
          success: false,
          message: 'Document was already processed by another request (race condition prevented)'
        });
      }

      // Try to remove any pending escalation job
      await cancelEscalationJob(doc.escalationJobId);

      // Notify that document is fully approved
      try {
        await notifyQueue.add('document-approved', {
          type: 'document_approved',
          documentId: documentId.toString(),
          documentName: updatedDoc.fileName,
          approvedBy: userId
        });
      } catch (err) {
        console.error(`[WorkflowRoutes] Failed to queue approval notification:`, err.message);
      }

      return res.json({
        success: true,
        status: 'approved',
        message: 'Document fully approved',
        step: currentStep + 1,
        totalSteps: doc.approvalChain.length
      });

    } else {
      // ── Intermediate approval — advance to next approver ────────────────────
      const nextApprover = doc.approvalChain[nextStep];

      const updatedDoc = await Document.findOneAndUpdate(
        {
          _id: documentId,
          status: 'pending_approval',
          currentApprover: new mongoose.Types.ObjectId(userId),
          approvalStep: currentStep
        },
        {
          $set: {
            approvalStep: nextStep,
            currentApprover: nextApprover.userId,
            [`approvalChain.${currentStep}.status`]: 'approved',
            [`approvalChain.${currentStep}.actedAt`]: new Date()
          },
          $push: {
            history: {
              status: 'approved-step',
              actor: userId,
              note: note || `Approved step ${currentStep + 1}/${doc.approvalChain.length} (${doc.approvalChain[currentStep].role}). Next: ${nextApprover.role}`,
              timestamp: new Date()
            }
          }
        },
        { new: true }
      );

      if (!updatedDoc) {
        return res.status(409).json({
          success: false,
          message: 'Document was already processed by another request (race condition prevented)'
        });
      }

      // Cancel old escalation and schedule new one
      await cancelEscalationJob(doc.escalationJobId);

      try {
        const newEscalationJob = await escalationQueue.add(
          'check-escalation',
          {
            documentId: documentId.toString(),
            expectedStep: nextStep,
            chainLength: doc.approvalChain.length
          },
          {
            delay: ESCALATION_SLA_MS,
            jobId: `escalation-${documentId}-step-${nextStep}-${Date.now()}`
          }
        );

        await Document.findByIdAndUpdate(documentId, {
          escalationJobId: newEscalationJob.id
        });
      } catch (err) {
        console.error('[WorkflowRoutes] Failed to schedule escalation:', err.message);
      }

      // Notify the next approver
      try {
        await notifyQueue.add('approver-assigned', {
          type: 'approver_assigned',
          documentId: documentId.toString(),
          approverId: nextApprover.userId.toString(),
          approverRole: nextApprover.role,
          documentName: updatedDoc.fileName,
          step: nextStep,
          totalSteps: doc.approvalChain.length
        });
      } catch (err) {
        console.error('[WorkflowRoutes] Failed to queue notification:', err.message);
      }

      return res.json({
        success: true,
        status: 'approved-step',
        message: `Step ${currentStep + 1} approved. Awaiting ${nextApprover.role} (step ${nextStep + 1}/${doc.approvalChain.length})`,
        step: nextStep + 1,
        totalSteps: doc.approvalChain.length,
        nextApproverRole: nextApprover.role
      });
    }

  } catch (err) {
    console.error('[WorkflowRoutes] Approve error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /documents/:id/reject
 *
 * Reject the document at the current approval step.
 * Immediately stops the approval chain — no further steps are processed.
 * The requester MUST be the document's currentApprover — otherwise 403.
 *
 * @param {string} req.params.id - Document ID
 * @param {string} req.body.reason - Required rejection reason
 */
router.post('/documents/:id/reject', async (req, res) => {
  try {
    const documentId = req.params.id;
    const userId = req.user.id;
    const { reason } = req.body;

    if (!mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({ success: false, message: 'Invalid document ID' });
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    }

    const doc = await Document.findById(documentId);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    if (doc.status !== 'pending_approval') {
      return res.status(400).json({
        success: false,
        message: `Document is not pending approval (current status: ${doc.status})`
      });
    }

    // Authorization: only the current approver can reject
    if (!doc.currentApprover || doc.currentApprover.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You are not the current assigned approver for this document'
      });
    }

    const currentStep = doc.approvalStep;

    // Atomically reject — concurrency-safe via filter preconditions
    const updatedDoc = await Document.findOneAndUpdate(
      {
        _id: documentId,
        status: 'pending_approval',
        currentApprover: new mongoose.Types.ObjectId(userId),
        approvalStep: currentStep
      },
      {
        $set: {
          status: 'rejected',
          rejectionReason: reason.trim(),
          [`approvalChain.${currentStep}.status`]: 'rejected',
          [`approvalChain.${currentStep}.actedAt`]: new Date(),
          currentApprover: null,
          escalationJobId: null
        },
        $push: {
          history: {
            status: 'rejected',
            actor: userId,
            note: `Rejected at step ${currentStep + 1}/${doc.approvalChain.length} (${doc.approvalChain[currentStep].role}). Reason: ${reason.trim()}`,
            timestamp: new Date()
          }
        }
      },
      { new: true }
    );

    if (!updatedDoc) {
      return res.status(409).json({
        success: false,
        message: 'Document was already processed by another request (race condition prevented)'
      });
    }

    // Cancel pending escalation
    await cancelEscalationJob(doc.escalationJobId);

    // Mark remaining chain steps as skipped
    for (let i = currentStep + 1; i < doc.approvalChain.length; i++) {
      await Document.findByIdAndUpdate(documentId, {
        $set: { [`approvalChain.${i}.status`]: 'skipped' }
      });
    }

    // Notify about rejection
    try {
      await notifyQueue.add('document-rejected', {
        type: 'document_rejected',
        documentId: documentId.toString(),
        documentName: updatedDoc.fileName,
        rejectedBy: userId,
        reason: reason.trim(),
        step: currentStep + 1,
        totalSteps: doc.approvalChain.length
      });
    } catch (err) {
      console.error('[WorkflowRoutes] Failed to queue rejection notification:', err.message);
    }

    return res.json({
      success: true,
      status: 'rejected',
      message: `Document rejected at step ${currentStep + 1}`,
      reason: reason.trim()
    });

  } catch (err) {
    console.error('[WorkflowRoutes] Reject error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /documents/:id/history
 *
 * Retrieve the immutable audit trail for a document.
 * Returns the full history array — no filtering or pagination for now
 * (history arrays are typically small, < 50 entries).
 *
 * @param {string} req.params.id - Document ID
 */
router.get('/documents/:id/history', async (req, res) => {
  try {
    const documentId = req.params.id;

    if (!mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({ success: false, message: 'Invalid document ID' });
    }

    const doc = await Document.findById(documentId)
      .select('fileName status approvalChain approvalStep currentApprover history')
      .populate('currentApprover', 'username email role')
      .populate('approvalChain.userId', 'username email role');

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    return res.json({
      success: true,
      document: {
        _id: doc._id,
        fileName: doc.fileName,
        status: doc.status,
        currentApprover: doc.currentApprover,
        approvalChain: doc.approvalChain,
        approvalStep: doc.approvalStep,
        history: doc.history
      }
    });

  } catch (err) {
    console.error('[WorkflowRoutes] History error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Helper: attempt to cancel/remove a pending escalation job from the queue.
 * Silently swallows errors — failing to cancel a stale job is non-fatal
 * because the escalation worker has its own stale-job detection.
 *
 * @param {string|null} jobId - The BullMQ job ID to cancel
 */
async function cancelEscalationJob(jobId) {
  if (!jobId) return;
  try {
    const job = await escalationQueue.getJob(jobId);
    if (job) {
      await job.remove();
      console.log(`[WorkflowRoutes] Cancelled escalation job ${jobId}`);
    }
  } catch (err) {
    // Non-fatal: the escalation worker will no-op anyway due to stale-job detection
    console.warn(`[WorkflowRoutes] Could not cancel escalation job ${jobId}:`, err.message);
  }
}

module.exports = router;
