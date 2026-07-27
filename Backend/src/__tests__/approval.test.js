/**
 * @fileoverview Unit tests for the approval flow (approve/reject routes).
 *
 * Tests the Express route handlers' authorization logic, concurrency safety,
 * and chain advancement behavior using mocked MongoDB and queue operations.
 *
 * Covers: unauthorized approver rejection (403), race condition handling (409),
 * successful approval chain advancement, rejection with reason, and final approval.
 */

const mongoose = require('mongoose');

// ── Mocks ────────────────────────────────────────────────────────────────────
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

jest.mock('../config/queue', () => ({
  redisConnection: {},
  escalationQueue: {
    add: jest.fn().mockResolvedValue({ id: 'esc-job-1' }),
    getJob: jest.fn().mockResolvedValue({ remove: jest.fn() })
  },
  notifyQueue: {
    add: jest.fn().mockResolvedValue({})
  }
}));

jest.mock('../../middlewares/auth.middleware', () => {
  return (req, res, next) => next();
});

const request = require('supertest');
const express = require('express');

// Create a test Express app with the workflow routes
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Mock auth: inject user
  app.use((req, res, next) => {
    req.user = { id: 'approver-user-1' };
    req.userRole = 'financeManager';
    next();
  });

  const workflowRoutes = require('../routes/workflowRoutes');
  app.use('/api/workflow', workflowRoutes);
  return app;
}

const Document = require('../../models/document.model');
const { escalationQueue, notifyQueue } = require('../config/queue');

// Reusable mock document factory
function createMockDoc(overrides = {}) {
  const approverId = new mongoose.Types.ObjectId();
  return {
    _id: new mongoose.Types.ObjectId(),
    status: 'pending_approval',
    currentApprover: approverId,
    approvalStep: 0,
    escalationJobId: 'esc-job-1',
    fileName: 'test.pdf',
    approvalChain: [
      { role: 'financeManager', userId: approverId, status: 'pending' },
      { role: 'admin', userId: new mongoose.Types.ObjectId(), status: 'pending' }
    ],
    history: [],
    ...overrides
  };
}

describe('POST /api/workflow/documents/:id/approve', () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 403 when requester is NOT the current approver', async () => {
    const doc = createMockDoc({
      currentApprover: new mongoose.Types.ObjectId() // Different user
    });
    Document.__mockFindById.mockResolvedValue(doc);

    const res = await request(app)
      .post(`/api/workflow/documents/${doc._id}/approve`)
      .send({ note: 'Looks good' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not the current assigned approver/i);
    expect(Document.__mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('returns 400 when document is not pending_approval', async () => {
    const doc = createMockDoc({ status: 'approved' });
    // Make the currentApprover match the requester — use a valid ObjectId
    doc.currentApprover = new mongoose.Types.ObjectId();
    Document.__mockFindById.mockResolvedValue(doc);

    const res = await request(app)
      .post(`/api/workflow/documents/${doc._id}/approve`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not pending approval/i);
  });

  test('returns 409 on race condition (concurrent double-approve)', async () => {
    // Simulate: the doc looks valid on read, but findOneAndUpdate returns
    // null because another request already advanced the chain.
    const userId = 'approver-user-1';
    const approverOid = new mongoose.Types.ObjectId();

    const doc = createMockDoc({ currentApprover: approverOid });
    Document.__mockFindById.mockResolvedValue(doc);
    Document.__mockFindOneAndUpdate.mockResolvedValue(null); // Race condition!

    // Override the mock auth to use a matching ID
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, res, next) => {
      req.user = { id: approverOid.toString() };
      next();
    });
    const routes = require('../routes/workflowRoutes');
    testApp.use('/api/workflow', routes);

    const res = await request(testApp)
      .post(`/api/workflow/documents/${doc._id}/approve`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/race condition/i);
  });

  test('successfully advances chain on intermediate approval', async () => {
    const approverOid = new mongoose.Types.ObjectId();
    const nextApproverOid = new mongoose.Types.ObjectId();

    const doc = createMockDoc({
      currentApprover: approverOid,
      approvalChain: [
        { role: 'financeManager', userId: approverOid, status: 'pending' },
        { role: 'admin', userId: nextApproverOid, status: 'pending' }
      ]
    });

    Document.__mockFindById.mockResolvedValue(doc);
    Document.__mockFindOneAndUpdate.mockResolvedValue({ ...doc, approvalStep: 1 });
    Document.__mockFindByIdAndUpdate.mockResolvedValue(doc);

    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, res, next) => {
      req.user = { id: approverOid.toString() };
      next();
    });
    const routes = require('../routes/workflowRoutes');
    testApp.use('/api/workflow', routes);

    const res = await request(testApp)
      .post(`/api/workflow/documents/${doc._id}/approve`)
      .send({ note: 'Approved by finance' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved-step');
    expect(res.body.nextApproverRole).toBe('admin');

    // Should notify next approver
    expect(notifyQueue.add).toHaveBeenCalled();
    // Should schedule escalation for next step
    expect(escalationQueue.add).toHaveBeenCalled();
  });

  test('successfully completes chain on final approval', async () => {
    const approverOid = new mongoose.Types.ObjectId();

    const doc = createMockDoc({
      currentApprover: approverOid,
      approvalStep: 1, // Last step
      approvalChain: [
        { role: 'financeManager', userId: new mongoose.Types.ObjectId(), status: 'approved' },
        { role: 'admin', userId: approverOid, status: 'pending' }
      ]
    });

    Document.__mockFindById.mockResolvedValue(doc);
    Document.__mockFindOneAndUpdate.mockResolvedValue({ ...doc, status: 'approved' });

    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, res, next) => {
      req.user = { id: approverOid.toString() };
      next();
    });
    const routes = require('../routes/workflowRoutes');
    testApp.use('/api/workflow', routes);

    const res = await request(testApp)
      .post(`/api/workflow/documents/${doc._id}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.message).toMatch(/fully approved/i);
  });

  test('returns 400 for invalid document ID', async () => {
    const res = await request(app)
      .post('/api/workflow/documents/not-a-valid-id/approve')
      .send({});

    expect(res.status).toBe(400);
  });

  test('returns 404 when document does not exist', async () => {
    Document.__mockFindById.mockResolvedValue(null);

    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post(`/api/workflow/documents/${fakeId}/approve`)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe('POST /api/workflow/documents/:id/reject', () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 when rejection reason is missing', async () => {
    const doc = createMockDoc();
    Document.__mockFindById.mockResolvedValue(doc);

    const res = await request(app)
      .post(`/api/workflow/documents/${doc._id}/reject`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reason is required/i);
  });

  test('returns 403 when requester is NOT the current approver', async () => {
    const doc = createMockDoc({
      currentApprover: new mongoose.Types.ObjectId()
    });
    Document.__mockFindById.mockResolvedValue(doc);

    const res = await request(app)
      .post(`/api/workflow/documents/${doc._id}/reject`)
      .send({ reason: 'Invalid amount' });

    expect(res.status).toBe(403);
  });

  test('successfully rejects with reason and stops chain', async () => {
    const approverOid = new mongoose.Types.ObjectId();
    const doc = createMockDoc({ currentApprover: approverOid });
    Document.__mockFindById.mockResolvedValue(doc);
    Document.__mockFindOneAndUpdate.mockResolvedValue({ ...doc, status: 'rejected' });
    Document.__mockFindByIdAndUpdate.mockResolvedValue(doc);

    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, res, next) => {
      req.user = { id: approverOid.toString() };
      next();
    });
    const routes = require('../routes/workflowRoutes');
    testApp.use('/api/workflow', routes);

    const res = await request(testApp)
      .post(`/api/workflow/documents/${doc._id}/reject`)
      .send({ reason: 'Fraudulent invoice' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.reason).toBe('Fraudulent invoice');

    // Should notify about rejection
    expect(notifyQueue.add).toHaveBeenCalledWith(
      'document-rejected',
      expect.objectContaining({
        type: 'document_rejected',
        reason: 'Fraudulent invoice'
      })
    );
  });
});
