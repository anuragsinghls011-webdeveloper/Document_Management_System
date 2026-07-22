const mongoose = require("mongoose");
const path = require("path");
const Document = require("../models/document.model");
const Approval = require("../models/approval.model");
const Activity = require("../models/activity.model");
const User = require("../models/user.model");
const extractText = require("../services/ocr.service");
const { analyzeDocument, extractKeywords, generateSummary, getRoleForDepartment } = require("../services/ai.service");

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
async function enrichDocument(docId, filePath, originalName) {
  let text = "";

  try {
    text = await extractText(filePath);
  } catch (err) {
    console.error("Text extraction failed for", originalName, err);
  }

  // Run AI analysis (Gemini or fallback)
  let analysis;
  try {
    analysis = await analyzeDocument(text);
  } catch (err) {
    console.error("AI analysis failed for", originalName, err);
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
    console.error("Routing lookup failed:", err.message);
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

    console.log(`✓ AI Analysis Complete: "${originalName}" → Type: ${analysis.documentType}, Dept: ${analysis.department}, Routed to: ${routedToName}`);
  }
}

const enrichmentQueue = [];
let isProcessingQueue = false;

async function processEnrichmentQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (enrichmentQueue.length > 0) {
    const { docId, filePath, originalName } = enrichmentQueue.shift();
    try {
      await enrichDocument(docId, filePath, originalName);
    } catch (err) {
      console.error("DOCUMENT ENRICHMENT ERROR", err);
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
        console.error("FAILED TO MARK DOCUMENT PENDING AFTER ENRICHMENT ERROR", updateErr);
      }
    }
  }

  isProcessingQueue = false;
}

function queueDocumentEnrichment(docId, filePath, originalName) {
  enrichmentQueue.push({ docId, filePath, originalName });
  processEnrichmentQueue();
}


exports.upload = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).send("No files");
    }

    const userId = new mongoose.Types.ObjectId(req.user.id);

    for (const file of req.files) {
      const doc = await Document.create({
        userId,
        fileName: file.originalname,
        fileType: path.extname(file.originalname).replace(/^\./, "") || "unknown",
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

      console.log("DOCUMENT SAVED ", doc._id);
    }

    res.json({ message: "Uploaded successfully", processing: true });

  } catch (err) {
    console.error("UPLOAD ERROR ", err);
    res.status(500).send(err.message);
  }
};


exports.getDocuments = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? {} : { userId };

    const docs = await Document.find(baseQuery)
      .populate("routedTo", "username email role")
      .sort({ createdAt: -1 });

    res.json(docs);
  } catch (err) {
    console.error("FETCH DOCS ERROR ", err);
    res.status(500).send("Failed to fetch documents");
  }
};


exports.myDocuments = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? {} : { userId };

    const docs = await Document.find(baseQuery)
      .populate("routedTo", "username email role")
      .sort({ createdAt: -1 });

    res.json(docs);
  } catch (err) {
    console.error("FETCH DOCS ERROR ", err);
    res.status(500).send("Failed to fetch documents");
  }
};


exports.stats = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? {} : { userId };

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
        { $match: isAdmin ? {} : { userId } },
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
    console.error("STATS ERROR ", err);
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

    const query = isAdmin ? {} : { userId };


    if (q && q.trim() !== "") {
      query.fileName = { $regex: escapeRegex(q), $options: "i" };
    }


    const normalizedStatus = normalizeStatus(status);
    if (normalizedStatus) {
      query.status = normalizedStatus;
    }


    if (type && type !== "all") {
      query.fileType = { $regex: new RegExp(`^${escapeRegex(type)}$`, "i") };
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
    console.error("Search error:", err);
    res.status(500).json([]);
  }
};

exports.recent = async (req, res) => {
  try {
    const isAdmin = req.userRole === "admin";
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const baseQuery = isAdmin ? {} : { userId };

    const docs = await Document.find(baseQuery)
      .sort({ createdAt: -1 })
      .limit(5);

    const data = docs.map(doc => ({
      document: doc.fileName,
      time: doc.createdAt
    }));

    res.json(data);
  } catch (err) {
    console.error("Recent error:", err);
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

    // Optionally delete the file from disk (fs.unlink)
    const fs = require("fs");
    const filePath = path.join(__dirname, "..", doc.filePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ message: "Document deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
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
    console.error("Download error:", err);
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
    console.error("View error:", err);
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
    console.error("Analysis fetch error:", err);
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
    console.error("Reanalyze error:", err);
    res.status(500).json({ success: false, message: "Failed to start re-analysis" });
  }
};

// ─── Re-analyze all stuck/unanalyzed documents ──────────────────────────────
exports.reanalyzeAll = async (req, res) => {
  try {
    const result = await reanalyzeStuckDocuments();
    res.json({ success: true, message: `Re-analysis queued for ${result} document(s)` });
  } catch (err) {
    console.error("Reanalyze all error:", err);
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
      console.log("✓ No stuck documents found.");
      return 0;
    }

    console.log(`⚙ Found ${stuckDocs.length} document(s) needing AI analysis. Queuing...`);

    for (const doc of stuckDocs) {
      doc.status = "processing";
      await doc.save();

      const filePath = path.join(__dirname, "..", doc.filePath);
      queueDocumentEnrichment(doc._id, filePath, doc.fileName);
    }

    return stuckDocs.length;
  } catch (err) {
    console.error("reanalyzeStuckDocuments error:", err);
    return 0;
  }
}

// Export for use in app.js startup
exports.reanalyzeStuckDocuments = reanalyzeStuckDocuments;

