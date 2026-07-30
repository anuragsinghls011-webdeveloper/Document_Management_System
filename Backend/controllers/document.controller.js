const mongoose = require("mongoose");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const Document = require("../models/document.model");
const Approval = require("../models/approval.model");
const Activity = require("../models/activity.model");
const User = require("../models/user.model");
const extractText = require("../services/ocr.service");
const { analyzeDocument, extractKeywords, generateSummary, getRoleForDepartment } = require("../services/ai.service");
const logger = require("../config/logger").createChildLogger("DocumentController");

const STATUS_ALIASES = {
  pending: "pending",
  processing: "processing",
  review: "review",
  "in review": "review",
  approved: "approved",
  rejected: "rejected",
  "changes requested": "changes_requested",
  changes_requested: "changes_requested",
  archived: "archived"
};

function normalizeStatus(status) {
  return STATUS_ALIASES[String(status || "").trim().toLowerCase()];
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── AI-Powered Document Enrichment ─────────────────────────────────────────
// This function is exported so the BullMQ enrichmentWorker can call it directly.
async function enrichDocument(docId, filePath, originalName) {
  let text = "";

  try {
    text = await extractText(filePath);
  } catch (err) {
    logger.error("Text extraction failed", { originalName, error: err.message });
  }

  // Run AI analysis (Gemini or fallback)
  let analysis;
  try {
    analysis = await analyzeDocument(text);
  } catch (err) {
    logger.error("AI analysis failed", { originalName, error: err.message });
    analysis = {
      documentType: "Other",
      department: "General",
      summary: "No summary available.",
      keywords: extractKeywords(text),
      confidence: 0
    };
  }

  // Find the appropriate department manager to route the document to
  let routedToUser = null;
  try {
    const targetRole = getRoleForDepartment(analysis.department);

    // Try to find a user with the matching department role
    routedToUser = await User.findOne({ role: targetRole });

    // Fallback: if no department manager found, route to admin
    if (!routedToUser) {
      routedToUser = await User.findOne({ role: "admin" });
    }
  } catch (err) {
    logger.error("Routing lookup failed", { error: err.message });
  }

  // Update document with all AI analysis data
  const updateData = {
    extractedText: text,
    summary: analysis.summary || generateSummary(text) || "No summary available.",
    keywords: analysis.keywords.length > 0 ? analysis.keywords : extractKeywords(text),
    documentType: analysis.documentType,
    department: analysis.department,
    aiSummary: analysis.summary,
    confidence: analysis.confidence,
    status: "pending"
  };

  if (routedToUser) {
    updateData.routedTo = routedToUser._id;
  }

  const updatedDoc = await Document.findByIdAndUpdate(docId, updateData, { new: true });

  if (updatedDoc) {
    // Create approval record assigned to the routed manager
    const approvalData = {
      documentId: updatedDoc._id,
      requestedBy: updatedDoc.userId,
      status: "pending"
    };

    if (routedToUser) {
      approvalData.reviewedBy = undefined; // will be set when they review
    }

    await Approval.create(approvalData);

    // Log AI routing activity
    const routedToName = routedToUser ? routedToUser.username : "Administrator";
    await Activity.create({
      user: updatedDoc.userId,
      action: `AI routed document to ${analysis.department} department`,
      entityType: "Document",
      entityName: updatedDoc.fileName,
      comment: `Type: ${analysis.documentType} | Dept: ${analysis.department} | Routed to: ${routedToName} | Confidence: ${Math.round(analysis.confidence * 100)}%`
    });

    logger.info(`✓ AI Analysis Complete: "${originalName}" → Type: ${analysis.documentType}, Dept: ${analysis.department}, Routed to: ${routedToName}`);
  }
}

// ─── Enrichment Queue (BullMQ with in-process fallback) ─────────────────────
//
// When Redis is configured (REDIS_HOST), jobs are pushed to a BullMQ queue
// that persists in Redis. The enrichmentWorker processes them.
//
// When Redis is NOT configured (local dev without Redis), we fall back to
// sequential in-process execution so the system still works.

let _bullmqAvailable = false;
let _enrichmentQueue = null;

try {
  if (process.env.REDIS_HOST) {
    const { enrichmentQueue } = require("../src/config/queue");
    _enrichmentQueue = enrichmentQueue;
    _bullmqAvailable = true;
  }
} catch (err) {
  logger.warn("BullMQ enrichment queue not available, using in-process fallback", { error: err.message });
}

// In-process fallback queue (only used when Redis is not available)
const _fallbackQueue = [];
let _isFallbackProcessing = false;

async function processFallbackQueue() {
  if (_isFallbackProcessing) return;
  _isFallbackProcessing = true;

  while (_fallbackQueue.length > 0) {
    const { docId, filePath, originalName } = _fallbackQueue.shift();
    try {
      await enrichDocument(docId, filePath, originalName);
    } catch (err) {
      logger.error("Enrichment failed (fallback queue)", { docId, error: err.message });
      try {
        const updatedDoc = await Document.findByIdAndUpdate(docId, {
          status: "pending",
          summary: "No summary available."
        }, { new: true });
        
        if (updatedDoc) {
          await Approval.create({
            documentId: updatedDoc._id,
            requestedBy: updatedDoc.userId,
            status: "pending"
          });
        }
      } catch (updateErr) {
        logger.error("Failed to mark document pending after enrichment error", { docId, error: updateErr.message });
      }
    }
  }

  _isFallbackProcessing = false;
}

function queueDocumentEnrichment(docId, filePath, originalName) {
  if (_bullmqAvailable && _enrichmentQueue) {
    // Production path: persistent Redis-backed queue
    _enrichmentQueue.add('enrich-document', {
      docId: docId.toString(),
      filePath,
      originalName
    }).then(() => {
      logger.info("Document queued for enrichment (BullMQ)", { docId: docId.toString(), originalName });
    }).catch(err => {
      logger.error("Failed to queue enrichment job, falling back to in-process", { docId: docId.toString(), error: err.message });
      // Fallback: process in-memory if Redis queue fails
      _fallbackQueue.push({ docId, filePath, originalName });
      processFallbackQueue();
    });
  } else {
    // Development fallback: in-process sequential queue
    _fallbackQueue.push({ docId, filePath, originalName });
    processFallbackQueue();
  }
}


exports.upload = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).send("No files");
    }

    const userId = new mongoose.Types.ObjectId(req.user.id);

    for (const file of req.files) {
      // Calculate file hash asynchronously to avoid blocking the event loop
      const fileBuffer = await fs.promises.readFile(file.path);
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      // Check for duplicate
      const existingDoc = await Document.findOne({ fileHash });
      if (existingDoc) {
        logger.warn(`Skipping duplicate upload "${file.originalname}" (hash match)`);
        
        await Activity.create({
          user: req.user.id,
          action: "Manual upload: duplicate blocked",
          entityType: "Document",
          entityName: file.originalname,
          comment: `Blocked identical file: ${existingDoc.fileName}`
        });

        // Remove the duplicate uploaded file asynchronously
        await fs.promises.unlink(file.path).catch(err => 
          logger.warn(`Failed to unlink duplicate file ${file.path}`, { error: err.message })
        );
        continue;
      }

      const doc = await Document.create({
        userId,
        fileName: file.originalname,
        fileType: path.extname(file.originalname).replace(/^\./, "") || "unknown",
        fileHash,
        filePath: `uploads/${file.filename}`,
        extractedText: "",
        summary: "",
        keywords: [],
        status: "processing"
      });

      await Activity.create({
        user: req.user.id,
        action: "Uploaded document",
        entityType: "Document",
        entityName: doc.fileName
      });

      queueDocumentEnrichment(doc._id, file.path, file.originalname);

      logger.info("Document saved", { docId: doc._id });
    }

    res.json({ message: "Uploaded successfully", processing: true });

  } catch (err) {
    logger.error("Upload error", { error: err.message });
    res.status(500).send(err.message);
  }
};


exports.getDocuments = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? {} : {
      $or: [
        { userId: userId },
        { routedTo: userId },
        { currentApprover: userId },
        { "approvalChain.userId": userId }
      ]
    };

    const docs = await Document.find(baseQuery)
      .populate("routedTo", "username email role")
      .sort({ createdAt: -1 });

    res.json(docs);
  } catch (err) {
    logger.error("Fetch docs error", { error: err.message });
    res.status(500).send("Failed to fetch documents");
  }
};


exports.myDocuments = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? {} : {
      $or: [
        { userId: userId },
        { routedTo: userId },
        { currentApprover: userId },
        { "approvalChain.userId": userId }
      ]
    };

    const docs = await Document.find(baseQuery)
      .populate("routedTo", "username email role")
      .sort({ createdAt: -1 });

    res.json(docs);
  } catch (err) {
    logger.error("Fetch my docs error", { error: err.message });
    res.status(500).send("Failed to fetch documents");
  }
};


exports.stats = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? {} : {
      $or: [
        { userId: userId },
        { routedTo: userId },
        { currentApprover: userId },
        { "approvalChain.userId": userId }
      ]
    };

    const [total, today, pending, archived, monthlyAgg] = await Promise.all([
      Document.countDocuments(baseQuery),
      Document.countDocuments({
        ...baseQuery,
        createdAt: {
          $gte: new Date(new Date().setHours(0, 0, 0, 0))
        }
      }),
      Document.countDocuments({ ...baseQuery, status: "pending" }),
      Document.countDocuments({ ...baseQuery, status: "archived" }),
      Document.aggregate([
        { $match: isAdmin ? {} : {
          $or: [
            { userId: userId },
            { routedTo: userId },
            { currentApprover: userId },
            { "approvalChain.userId": userId }
          ]
        } },
        {
          $group: {
            _id: { $month: "$createdAt" },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    const monthly = Array(12).fill(0);
    monthlyAgg.forEach(entry => {
      const monthIndex = entry._id - 1;
      if (monthIndex >= 0 && monthIndex < 12) {
        monthly[monthIndex] = entry.count;
      }
    });

    res.json({
      total,
      today,
      pending,
      archived,
      monthly
    });

  } catch (err) {
    logger.error("Stats error", { error: err.message });
    res.status(500).send("Stats error");
  }
};

exports.search = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    let { q, status, type, date, department } = req.query;

    // Coerce arrays to strings to prevent DoS via type juggling
    q = typeof q === 'string' ? q : (Array.isArray(q) ? q[0] : (q ? String(q) : ''));
    status = typeof status === 'string' ? status : (Array.isArray(status) ? status[0] : (status ? String(status) : ''));
    type = typeof type === 'string' ? type : (Array.isArray(type) ? type[0] : (type ? String(type) : ''));
    date = typeof date === 'string' ? date : (Array.isArray(date) ? date[0] : (date ? String(date) : ''));
    department = typeof department === 'string' ? department : (Array.isArray(department) ? department[0] : (department ? String(department) : ''));

    const query = isAdmin ? {} : {
      $or: [
        { userId: userId },
        { routedTo: userId },
        { currentApprover: userId },
        { "approvalChain.userId": userId }
      ]
    };

    if (q && q.trim() !== "") {
      const qRegex = new RegExp(escapeRegex(q.trim()), "i");
      query.$or = [
        { fileName: qRegex },
        { documentType: qRegex },
        { department: qRegex },
        { keywords: qRegex }
      ];
    }

    const normalizedStatus = normalizeStatus(status);
    if (normalizedStatus) {
      query.status = normalizedStatus;
    }

    if (type && type !== "all") {
      if (type.toLowerCase() === 'jpg') {
        query.fileType = { $regex: new RegExp(`^(jpg|jpeg)$`, "i") };
      } else {
        query.fileType = { $regex: new RegExp(`^${escapeRegex(type)}$`, "i") };
      }
    }

    // Department filter
    if (department && department !== "all" && department !== "") {
      query.department = department;
    }

    if (date) {
      const start = new Date(date);
      if (Number.isNaN(start.getTime())) {
        return res.status(400).json({ message: "Invalid date format" });
      }

      const end = new Date(date);
      end.setHours(23, 59, 59, 999);

      query.createdAt = { $gte: start, $lte: end };
    }

    const docs = await Document.find(query)
      .populate("routedTo", "username email role")
      .sort({ createdAt: -1 });

    res.json(docs);

  } catch (err) {
    logger.error("Search error", { error: err.message });
    res.status(500).json([]);
  }
};

exports.recent = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? {} : {
      $or: [
        { userId: userId },
        { routedTo: userId },
        { currentApprover: userId },
        { "approvalChain.userId": userId }
      ]
    };

    const docs = await Document.find(baseQuery)
      .sort({ createdAt: -1 })
      .limit(5);

    const data = docs.map(doc => ({
      document: doc.fileName,
      time: doc.createdAt
    }));

    res.json(data);
  } catch (err) {
    logger.error("Recent error", { error: err.message });
    res.status(500).json([]);
  }
};

exports.deleteDocument = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? { _id: req.params.id } : { _id: req.params.id, userId };
    
    const doc = await Document.findOneAndDelete(baseQuery);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Delete the file from disk asynchronously
    const fsPromises = require("fs").promises;
    const filePath = path.join(__dirname, "..", doc.filePath);
    
    fsPromises.unlink(filePath).catch(err => {
      // Ignore ENOENT (file doesn't exist)
      if (err.code !== 'ENOENT') {
        logger.error("Failed to delete file from disk", { filePath, error: err.message });
      }
    });

    res.json({ message: "Document deleted successfully" });
  } catch (err) {
    logger.error("Delete error", { error: err.message });
    res.status(500).json({ message: "Failed to delete document" });
  }
};

exports.downloadDocument = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? { _id: req.params.id } : { _id: req.params.id, userId };

    const doc = await Document.findOne(baseQuery);
    if (!doc) {
      return res.status(404).send("Document not found");
    }

    const filePath = path.join(__dirname, "..", doc.filePath);
    res.download(filePath, doc.fileName);
  } catch (err) {
    logger.error("Download error", { error: err.message });
    res.status(500).send("Failed to download document");
  }
};

exports.viewDocument = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? { _id: req.params.id } : { _id: req.params.id, userId };

    const doc = await Document.findOne(baseQuery);
    if (!doc) {
      return res.status(404).send("Document not found");
    }

    const filePath = path.join(__dirname, "..", doc.filePath);
    res.sendFile(filePath);
  } catch (err) {
    logger.error("View error", { error: err.message });
    res.status(500).send("Failed to view document");
  }
};

// ─── AI Analysis Endpoint ───────────────────────────────────────────────────
exports.getAnalysis = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? { _id: req.params.id } : { _id: req.params.id, userId };

    const doc = await Document.findOne(baseQuery)
      .populate("routedTo", "username email role")
      .populate("userId", "username email");

    if (!doc) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    res.json({
      success: true,
      analysis: {
        _id: doc._id,
        fileName: doc.fileName,
        fileType: doc.fileType,
        documentType: doc.documentType || "Unknown",
        department: doc.department || "General",
        aiSummary: doc.aiSummary || doc.summary || "No summary available.",
        summary: doc.summary || "",
        keywords: doc.keywords || [],
        confidence: doc.confidence || 0,
        status: doc.status,
        routedTo: doc.routedTo ? {
          _id: doc.routedTo._id,
          username: doc.routedTo.username,
          email: doc.routedTo.email,
          role: doc.routedTo.role
        } : null,
        uploadedBy: doc.userId ? {
          username: doc.userId.username,
          email: doc.userId.email
        } : null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
      }
    });
  } catch (err) {
    logger.error("Analysis fetch error", { error: err.message });
    res.status(500).json({ success: false, message: "Failed to fetch analysis" });
  }
};

// ─── Re-analyze a single document ───────────────────────────────────────────
exports.reanalyzeSingle = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? { _id: req.params.id } : { _id: req.params.id, userId };

    const doc = await Document.findOne(baseQuery);
    if (!doc) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    // Mark as processing
    doc.status = "processing";
    await doc.save();

    // Re-run enrichment in background
    const filePath = path.join(__dirname, "..", doc.filePath);
    queueDocumentEnrichment(doc._id, filePath, doc.fileName);

    res.json({ success: true, message: "Re-analysis started" });
  } catch (err) {
    logger.error("Reanalyze error", { error: err.message });
    res.status(500).json({ success: false, message: "Failed to start re-analysis" });
  }
};

// ─── Re-analyze all stuck/unanalyzed documents ──────────────────────────────
exports.reanalyzeAll = async (req, res) => {
  try {
    const result = await reanalyzeStuckDocuments();
    res.json({ success: true, message: `Re-analysis queued for ${result} document(s)` });
  } catch (err) {
    logger.error("Reanalyze all error", { error: err.message });
    res.status(500).json({ success: false, message: "Failed to start re-analysis" });
  }
};

// ─── Startup: fix all stuck documents ───────────────────────────────────────
async function reanalyzeStuckDocuments() {
  try {
    // Find documents that are stuck in processing OR have no AI analysis
    const stuckDocs = await Document.find({
      $or: [
        { status: "processing" },
        { status: "pending", documentType: { $in: [null, ""] } },
        { status: "pending", department: { $in: [null, ""] } }
      ]
    });

    if (stuckDocs.length === 0) {
      logger.info("✓ No stuck documents found.");
      return 0;
    }

    logger.info(`⚙ Found ${stuckDocs.length} document(s) needing AI analysis. Queuing...`);

    for (const doc of stuckDocs) {
      doc.status = "processing";
      await doc.save();

      const filePath = path.join(__dirname, "..", doc.filePath);
      queueDocumentEnrichment(doc._id, filePath, doc.fileName);
    }

    return stuckDocs.length;
  } catch (err) {
    logger.error("reanalyzeStuckDocuments error", { error: err.message });
    return 0;
  }
}

// Export for use in app.js startup
exports.reanalyzeStuckDocuments = reanalyzeStuckDocuments;

// Export for use by email ingestion service — allows email-sourced documents
// to flow through the same AI enrichment pipeline as manually uploaded ones.
exports.queueDocumentEnrichment = queueDocumentEnrichment;

// Export enrichDocument so the BullMQ enrichmentWorker can call it directly.
exports.enrichDocument = enrichDocument;


