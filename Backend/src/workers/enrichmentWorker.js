/**
 * @fileoverview BullMQ worker for AI document enrichment.
 *
 * FLOW:
 * 1. A job arrives with { docId, filePath, originalName }
 * 2. Run OCR text extraction on the file
 * 3. Run Gemini AI analysis (classification, summarization, keyword extraction)
 * 4. Route the document to the appropriate department manager
 * 5. Create an approval record and log the activity
 *
 * This worker replaces the old in-memory enrichmentQueue[] array from
 * document.controller.js. Jobs are now persisted in Redis, so no work
 * is lost if the server crashes mid-processing.
 *
 * RETRY SAFETY:
 * BullMQ handles retries with exponential backoff (3 attempts).
 * On final failure, the document is set to "pending" with an empty summary
 * so it appears in the dashboard and can be manually re-analyzed.
 *
 * @module workers/enrichmentWorker
 */

const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const path = require('path');
const Document = require('../../models/document.model');
const Approval = require('../../models/approval.model');
const Activity = require('../../models/activity.model');
const User = require('../../models/user.model');
const extractText = require('../../services/ocr.service');
const { analyzeDocument, extractKeywords, generateSummary, getRoleForDepartment } = require('../../services/ai.service');
const { redisConnection } = require('../config/queue');
const { createChildLogger } = require('../../config/logger');

const logger = createChildLogger('EnrichmentWorker');

/**
 * Process a single enrichment job.
 *
 * @param {import('bullmq').Job} job
 * @param {Object} job.data
 * @param {string} job.data.docId - MongoDB _id of the document
 * @param {string} job.data.filePath - Absolute path to the uploaded file
 * @param {string} job.data.originalName - Original filename for logging
 */
async function processEnrichmentJob(job) {
  const { docId, filePath, originalName } = job.data;
  const logPrefix = `[${job.id}][doc:${docId}]`;

  logger.info(`${logPrefix} Starting enrichment for "${originalName}"`);

  let text = '';

  // ── Step 1: Text Extraction (OCR / PDF parse / plaintext) ────────────────
  try {
    text = await extractText(filePath);
  } catch (err) {
    logger.error(`${logPrefix} Text extraction failed for "${originalName}"`, { error: err.message });
  }

  // ── Step 2: AI Analysis (Gemini or fallback) ─────────────────────────────
  let analysis;
  try {
    analysis = await analyzeDocument(text);
  } catch (err) {
    logger.error(`${logPrefix} AI analysis failed for "${originalName}"`, { error: err.message });
    analysis = {
      documentType: 'Other',
      department: 'General',
      summary: 'No summary available.',
      keywords: extractKeywords(text),
      confidence: 0
    };
  }

  // ── Step 3: Route to department manager ──────────────────────────────────
  let routedToUser = null;
  try {
    const targetRole = getRoleForDepartment(analysis.department);
    routedToUser = await User.findOne({ role: targetRole });
    if (!routedToUser) {
      routedToUser = await User.findOne({ role: 'admin' });
    }
  } catch (err) {
    logger.error(`${logPrefix} Routing lookup failed`, { error: err.message });
  }

  // ── Step 4: Update document with AI results ──────────────────────────────
  const updateData = {
    extractedText: text,
    summary: analysis.summary || generateSummary(text) || 'No summary available.',
    keywords: analysis.keywords.length > 0 ? analysis.keywords : extractKeywords(text),
    documentType: analysis.documentType,
    department: analysis.department,
    aiSummary: analysis.summary,
    confidence: analysis.confidence,
    status: 'pending'
  };

  if (routedToUser) {
    updateData.routedTo = routedToUser._id;
  }

  const updatedDoc = await Document.findByIdAndUpdate(docId, updateData, { new: true });

  if (updatedDoc) {
    // Create approval record
    const approvalData = {
      documentId: updatedDoc._id,
      requestedBy: updatedDoc.userId,
      status: 'pending'
    };
    await Approval.create(approvalData);

    // Log activity
    const routedToName = routedToUser ? routedToUser.username : 'Administrator';
    await Activity.create({
      user: updatedDoc.userId,
      action: `AI routed document to ${analysis.department} department`,
      entityType: 'Document',
      entityName: updatedDoc.fileName,
      comment: `Type: ${analysis.documentType} | Dept: ${analysis.department} | Routed to: ${routedToName} | Confidence: ${Math.round(analysis.confidence * 100)}%`
    });

    logger.info(`${logPrefix} ✓ Enrichment complete: "${originalName}" → Type: ${analysis.documentType}, Dept: ${analysis.department}, Routed to: ${routedToName}`);
  }
}

/**
 * Create and start the enrichment worker.
 * @returns {import('bullmq').Worker} The running worker instance
 */
function startEnrichmentWorker() {
  const worker = new Worker('document-enrichment', processEnrichmentJob, {
    connection: redisConnection,
    concurrency: 3, // OCR + AI is CPU-heavy, limit parallelism
    limiter: {
      max: 10,
      duration: 1000 // Max 10 jobs per second
    }
  });

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed`, { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} failed: ${err.message}`, { jobId: job?.id, error: err.message });

    // On final failure, ensure the document is not stuck in "processing"
    if (job && job.data && job.attemptsMade >= (job.opts?.attempts || 3)) {
      const { docId } = job.data;
      Document.findByIdAndUpdate(docId, {
        status: 'pending',
        summary: 'No summary available.'
      }).then(() => {
        return Approval.create({
          documentId: new mongoose.Types.ObjectId(docId),
          status: 'pending'
        });
      }).catch(updateErr => {
        logger.error(`Failed to mark document pending after enrichment failure`, { docId, error: updateErr.message });
      });
    }
  });

  worker.on('error', (err) => {
    logger.error(`Worker error: ${err.message}`, { error: err.message });
  });

  logger.info('Enrichment worker started and listening for jobs');
  return worker;
}

module.exports = { startEnrichmentWorker, processEnrichmentJob };
