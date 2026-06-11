const mongoose = require("mongoose");
const Document = require("../models/document.model");

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
        fileType: file.originalname.split(".").pop(),
        filePath: `uploads/${file.filename}`,
        status: "pending"
      });

      console.log("DOCUMENT SAVED ", doc._id);
    }

    res.json({ message: "Uploaded successfully" });

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

    const total = await Document.countDocuments({ userId });

    const today = await Document.countDocuments({
      userId,
      createdAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0))
      }
    });

    const pending = await Document.countDocuments({
      userId,
      status: "pending"
    });

    const archived = await Document.countDocuments({
      userId,
      status: "archived"
    });

    const monthly = Array(12).fill(0);
    const docs = await Document.find({ userId });

    docs.forEach(doc => {
      const month = new Date(doc.createdAt).getMonth();
      monthly[month]++;
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
