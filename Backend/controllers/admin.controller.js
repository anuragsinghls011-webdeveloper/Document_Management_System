const mongoose = require("mongoose");
const Document = require("../models/document.model");
const Activity = require("../models/activity.model");

function isValidDocumentId(id) {
  return mongoose.isValidObjectId(id);
}

// Fetch pending documents
exports.pendingDocs = async (req, res) => {
  try {
    const pendingDocs = await Document.find({ status: "pending" })
      .populate("userId", "username email")
      .sort({ createdAt: -1 });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const approvedToday = await Document.countDocuments({
      status: "approved",
      updatedAt: { $gte: startOfToday }
    });

    const rejectedToday = await Document.countDocuments({
      status: "rejected",
      updatedAt: { $gte: startOfToday }
    });

    res.json({ 
      success: true, 
      documents: pendingDocs,
      approvedToday,
      rejectedToday
    });
  } catch (error) {
    console.error("PENDING DOCS ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Fetch single document
exports.getDocument = async (req, res) => {
  try {
    if (!isValidDocumentId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid document id" });
    }

    const doc = await Document.findById(req.params.id).populate("userId", "username email");

    if (!doc) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    res.json({ success: true, document: doc });
  } catch (error) {
    console.error("GET DOCUMENT ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Approve document
exports.approveDoc = async (req, res) => {
  try {
    if (!isValidDocumentId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid document id" });
    }

    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    doc.status = "approved";
    doc.approvedBy = req.user.id;
    doc.approvedAt = new Date();
    await doc.save();

    await Activity.create({
      user: req.user.id,
      action: "Approved document",
      entityType: "Document",
      entityName: doc.fileName
    });

    res.json({ success: true, status: doc.status });
  } catch (error) {
    console.error("APPROVE DOC ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Reject document
exports.rejectDoc = async (req, res) => {
  try {
    const { reason, comment } = req.body;
    const rejectionReason = reason || comment || "";

    if (!isValidDocumentId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid document id" });
    }

    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    doc.status = "rejected";
    doc.rejectionReason = rejectionReason;
    await doc.save();

    await Activity.create({
      user: req.user.id,
      action: "Rejected document",
      entityType: "Document",
      entityName: doc.fileName,
      comment: rejectionReason
    });

    res.json({ success: true, status: doc.status });
  } catch (error) {
    console.error("REJECT DOC ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Request document changes
exports.requestChanges = async (req, res) => {
  try {
    const { comment } = req.body;
    const reviewComment = comment ? comment.trim() : "";

    if (!isValidDocumentId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid document id" });
    }

    if (!reviewComment) {
      return res.status(400).json({
        success: false,
        message: "Comment is required when requesting changes"
      });
    }

    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Document not found"
      });
    }

    doc.status = "changes_requested";
    doc.reviewComment = reviewComment;
    await doc.save();

    await Activity.create({
      user: req.user.id,
      action: "Requested changes",
      entityType: "Document",
      entityName: doc.fileName,
      comment: reviewComment
    });

    return res.json({
      success: true,
      status: doc.status,
      message: "Changes requested successfully"
    });
  } catch (error) {
    console.error("REQUEST CHANGES ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while requesting changes"
    });
  }
};
