const mongoose = require("mongoose");
const path = require("path");
const Document = require("../models/document.model");
const Activity = require("../models/activity.model");
const extractText = require("../services/ocr.service");
const { extractKeywords, generateSummary } = require("../services/ai.service");

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

async function enrichDocument(docId, filePath, originalName) {
  let text = "";

  try {
    text = await extractText(filePath);
  } catch (err) {
    console.error("Text extraction failed for", originalName, err);
  }

  const keywords = extractKeywords(text);
  const summary = generateSummary(text) || "No summary available.";

  await Document.findByIdAndUpdate(docId, {
    extractedText: text,
    summary,
    keywords,
    status: "pending"
  });
}

function queueDocumentEnrichment(docId, filePath, originalName) {
  setImmediate(() => {
    enrichDocument(docId, filePath, originalName).catch((err) => {
      console.error("DOCUMENT ENRICHMENT ERROR", err);
      Document.findByIdAndUpdate(docId, {
        status: "pending",
        summary: "No summary available."
      }).catch((updateErr) => {
        console.error("FAILED TO MARK DOCUMENT PENDING AFTER ENRICHMENT ERROR", updateErr);
      });
    });
  });
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


exports.myDocuments = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const docs = await Document.find({ userId }).sort({ createdAt: -1 });

    res.json(docs);
  } catch (err) {
    console.error("FETCH DOCS ERROR ", err);
    res.status(500).send("Failed to fetch documents");
  }
};


exports.stats = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const [total, today, pending, archived, monthlyAgg] = await Promise.all([
      Document.countDocuments({ userId }),
      Document.countDocuments({
        userId,
        createdAt: {
          $gte: new Date(new Date().setHours(0, 0, 0, 0))
        }
      }),
      Document.countDocuments({ userId, status: "pending" }),
      Document.countDocuments({ userId, status: "archived" }),
      Document.aggregate([
        { $match: { userId } },
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
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { q, status, type, date } = req.query;

    const query = { userId };

    
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

    
    if (date) {
      const start = new Date(date);
      if (Number.isNaN(start.getTime())) {
        return res.status(400).json({ message: "Invalid date format" });
      }

      const end = new Date(date);
      end.setHours(23, 59, 59, 999);

      query.createdAt = { $gte: start, $lte: end };
    }

    const docs = await Document.find(query).sort({ createdAt: -1 });

    res.json(docs);

  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json([]);
  }
};

exports.recent = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const docs = await Document.find({ userId })
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
