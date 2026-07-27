/**
 * @fileoverview Unit tests for escalation logic.
 *
 * Tests the escalation worker's decision-making as pure logic,
 * using mocked MongoDB models and queue operations.
 *
 * Covers: chain advancement, chain exhaustion, stale-job detection,
 * and concurrent update safety.
 */

const mongoose = require('mongoose');

// ── Mocks ────────────────────────────────────────────────────────────────────
// Mock the Document model
jest.mock('../../models/document.model', () => {
  const mockFindById = jest.fn();
  const mockFindOneAndUpdate = jest.fn();
  const mockFindByIdAndUpdate = jest.fn();

  return {
    findById: mockFindById,
    findOneAndUpdate: mockFindOneAndUpdate,
    findByIdAndUpdate: mockFindByIdAndUpdate,
    __mockFindById: mockFindById,
    __mockFindOneAndUpdate: mockFindOneAndUpdate,
    __mockFindByIdAndUpdate: mockFindByIdAndUpdate
  };
});

// Mock the queue module
jest.mock('../config/queue', () => ({
  redisConnection: {},
  escalationQueue: {
    add: jest.fn().mockResolvedValue({ id: 'new-escalation-job-123' })
  },
  notifyQueue: {
    add: jest.fn().mockResolvedValue({})
  }
}));

// Mock approver resolver
jest.mock('../services/approverResolver', () => ({
  resolveApprover: jest.fn().mockResolvedValue('user-id-456')
}));

const Document = require('../../models/document.model');
const { escalationQueue, notifyQueue } = require('../config/queue');
const { processEscalationJob } = require('../workers/escalationWorker');

// Helper to create a mock BullMQ job
function createMockJob(data, jobId = 'test-job-1') {
  return {
    id: jobId,
    data,
    log: jest.fn()
  };
}

// Helper to create a mock document
function createMockDocument(overrides = {}) {
  const objectId = new mongoose.Types.ObjectId();
  return {
    _id: objectId,
    status: 'pending_approval',
    approvalStep: 0,
    escalationJobId: 'test-job-1',
    fileName: 'test-doc.pdf',
    approvalChain: [
      { role: 'financeManager', userId: new mongoose.Types.ObjectId(), status: 'pending' },
      { role: 'generalManager', userId: new mongoose.Types.ObjectId(), status: 'pending' },
      { role: 'admin', userId: new mongoose.Types.ObjectId(), status: 'pending' }
    ],
    ...overrides
  };
}

describe('Escalation Worker — processEscalationJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── STALE-JOB DETECTION ─────────────────────────────────────────────────────

  test('no-ops if document is not found', async () => {
    Document.__mockFindById.mockResolvedValue(null);

    const job = createMockJob({ documentId: 'missing-id', expectedStep: 0, chainLength: 3 });
    await processEscalationJob(job);

    expect(Document.__mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(notifyQueue.add).not.toHaveBeenCalled();
  });

  test('no-ops if document status is not pending_approval (already resolved)', async () => {
    const doc = createMockDocument({ status: 'approved' });
    Document.__mockFindById.mockResolvedValue(doc);

    const job = createMockJob({
      documentId: doc._id.toString(),
      expectedStep: 0,
      chainLength: 3
    });

    await processEscalationJob(job);

    expect(Document.__mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('no-ops if escalationJobId on document does not match this job', async () => {
    const doc = createMockDocument({ escalationJobId: 'different-job-id' });
    Document.__mockFindById.mockResolvedValue(doc);

    const job = createMockJob({
      documentId: doc._id.toString(),
      expectedStep: 0,
      chainLength: 3
    }, 'test-job-1');

    await processEscalationJob(job);

    expect(Document.__mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('no-ops if document approvalStep has already advanced past expected step', async () => {
    const doc = createMockDocument({ approvalStep: 2 }); // Already at step 2
    Document.__mockFindById.mockResolvedValue(doc);

    const job = createMockJob({
      documentId: doc._id.toString(),
      expectedStep: 0, // Job was for step 0
      chainLength: 3
    });

    await processEscalationJob(job);

    expect(Document.__mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // ── CHAIN ADVANCEMENT ───────────────────────────────────────────────────────

  test('advances chain to next approver when SLA expires', async () => {
    const doc = createMockDocument();
    Document.__mockFindById.mockResolvedValue(doc);
    Document.__mockFindOneAndUpdate.mockResolvedValue(doc);
    Document.__mockFindByIdAndUpdate.mockResolvedValue(doc);

    const job = createMockJob({
      documentId: doc._id.toString(),
      expectedStep: 0,
      chainLength: 3
    });

    await processEscalationJob(job);

    // Should call findOneAndUpdate to advance the chain
    expect(Document.__mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const updateCall = Document.__mockFindOneAndUpdate.mock.calls[0];

    // Filter should include status and step preconditions
    // Use toString() for ObjectId comparison since Mongoose ObjectIds
    // don't compare equal with toMatchObject's strict equality.
    expect(updateCall[0]._id.toString()).toBe(doc._id.toString());
    expect(updateCall[0].status).toBe('pending_approval');
    expect(updateCall[0].approvalStep).toBe(0);

    // Update should advance to step 1
    expect(updateCall[1].$set).toMatchObject({
      approvalStep: 1,
      'approvalChain.0.status': 'escalated'
    });

    // Should push a history entry
    expect(updateCall[1].$push.history.status).toBe('escalated');

    // Should notify next approver
    expect(notifyQueue.add).toHaveBeenCalled();

    // Should schedule next escalation
    expect(escalationQueue.add).toHaveBeenCalled();
  });

  // ── CHAIN EXHAUSTION ────────────────────────────────────────────────────────

  test('marks document as needs_review when chain is exhausted', async () => {
    const doc = createMockDocument({ approvalStep: 2 }); // At last step
    doc.escalationJobId = 'last-step-job';
    Document.__mockFindById.mockResolvedValue(doc);
    Document.__mockFindOneAndUpdate.mockResolvedValue(doc);

    const job = createMockJob(
      {
        documentId: doc._id.toString(),
        expectedStep: 2,   // Last step
        chainLength: 3     // 3 steps total (0, 1, 2)
      },
      'last-step-job'
    );

    await processEscalationJob(job);

    expect(Document.__mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const updateCall = Document.__mockFindOneAndUpdate.mock.calls[0];

    // Should set status to needs_review
    expect(updateCall[1].$set.status).toBe('needs_review');
    expect(updateCall[1].$set.escalationJobId).toBeNull();

    // History should record needs_review
    expect(updateCall[1].$push.history.status).toBe('needs_review');

    // Should notify about needs_review
    expect(notifyQueue.add).toHaveBeenCalledWith(
      'needs-review-notification',
      expect.objectContaining({
        type: 'needs_review',
        reason: expect.stringContaining('chain exhausted')
      })
    );

    // Should NOT schedule another escalation
    expect(escalationQueue.add).not.toHaveBeenCalled();
  });

  // ── CONCURRENT UPDATE SAFETY ────────────────────────────────────────────────

  test('handles concurrent update gracefully when findOneAndUpdate returns null', async () => {
    const doc = createMockDocument();
    Document.__mockFindById.mockResolvedValue(doc);
    // Simulate another process already handled this
    Document.__mockFindOneAndUpdate.mockResolvedValue(null);

    const job = createMockJob({
      documentId: doc._id.toString(),
      expectedStep: 0,
      chainLength: 3
    });

    // Should not throw
    await expect(processEscalationJob(job)).resolves.toBeUndefined();

    // Should not try to notify or schedule since the update failed
    expect(notifyQueue.add).not.toHaveBeenCalled();
    expect(escalationQueue.add).not.toHaveBeenCalled();
  });
});
