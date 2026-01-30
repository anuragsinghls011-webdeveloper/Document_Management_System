const mongoose = require("mongoose");
const Document = require("../models/document.model");
const extractText = require("../services/ocr.service");
const { extractKeywords, generateSummary } = require("../services/ai.service");




exports.upload = async (req, res) => {
  try {
    console.log("REQ.USER ", req.user);

    if (!req.files || req.files.length === 0) {
      return res.status(400).send("No files");
    }

    for (const file of req.files) {
      const doc = await Document.create({
        userId: new mongoose.Types.ObjectId(req.user.id),   
        fileName: file.originalname,
        fileType: file.originalname.split(".").pop(),
        filePath: file.path,
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
    const docs = await Document.find({ userId: new mongoose.Types.ObjectId(req.user.id) })
      .sort({ createdAt: -1 });

    res.json(docs);
  } catch (err) {
    console.error("FETCH DOCS ERROR ", err);
    res.status(500).send("Failed to fetch documents");
  }
};


exports.stats = async (req, res) => {
  try {
    const docs = await Document.find({ userId: req.user.id });

    const monthly = Array(12).fill(0);

    docs.forEach(doc => {
      const month = new Date(doc.createdAt).getMonth();
      monthly[month]++;
    });

    res.json({
      total: docs.length,
      monthly
    });
  } catch (err) {
    console.error("STATS ERROR ", err);
    res.status(500).send("Failed to load stats");
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
      query.fileName = { $regex: q, $options: "i" };
    }

    
    if (status && status !== "all") {
      query.status = { $regex: new RegExp(`^${status}$`, 'i') };
    }

    
    if (type && type !== "all") {
      query.fileType = { $regex: new RegExp(`^${type}$`, 'i') };
    }

    
    if (date) {
      const start = new Date(date);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);

      query.createdAt = { $gte: start, $lte: end };
    }

    console.log("SEARCH QUERY ", query);

    const docs = await Document.find(query).sort({ createdAt: -1 });

    res.json(docs);

  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json([]);
  }
};

exports.recent = async (req, res) => {
  try {
    const docs = await Document.find({})
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
