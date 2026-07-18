const mongoose = require("mongoose");
const Approval = require("../models/approval.model");
const Document = require("../models/document.model");
const Activity = require("../models/activity.model");

// Fetch pending approvals
exports.getPendingApprovals = async (req, res) => {
  try {
    const pendingApprovals = await Approval.find({ status: "pending" })
      .populate({
        path: "documentId",
        select: "fileName fileType createdAt summary keywords",
      })
      .populate("requestedBy", "username email")
      .sort({ createdAt: -1 });

    // Format the response to match the frontend expectations which expects 'documents' array
    const documents = pendingApprovals
      .filter(approval => approval.documentId) // ensure doc still exists
      .map(approval => ({
        _id: approval.documentId._id,
        approvalId: approval._id, // Keep approval id for later use
        fileName: approval.documentId.fileName,
        fileType: approval.documentId.fileType,
        createdAt: approval.createdAt, // approval requested date
        userId: approval.requestedBy,
        status: approval.status,
        summary: approval.documentId.summary,
        keywords: approval.documentId.keywords,
      }));

    res.json({ success: true, documents });
  } catch (error) {
    console.error("GET PENDING APPROVALS ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Make a decision on an approval (approve, reject, request_changes)
// Note: We use documentId here because frontend buttons pass document._id
exports.makeDecision = async (req, res) => {
  try {
    const documentId = req.params.id;
    const { action, comments } = req.body; // action: 'approve', 'reject', 'request_changes'

    if (!mongoose.isValidObjectId(documentId)) {
      return res.status(400).json({ success: false, message: "Invalid document id" });
    }

    if (!["approve", "reject", "request_changes"].includes(action)) {
      return res.status(400).json({ success: false, message: "Invalid action" });
    }

    // Find the latest pending approval for this document
    const approval = await Approval.findOne({ documentId, status: "pending" }).sort({ createdAt: -1 });
    const doc = await Document.findById(documentId);

    if (!doc) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    let statusString = "";
    let actionLogString = "";

    if (action === "approve") {
      statusString = "approved";
      actionLogString = "Approved document";
    } else if (action === "reject") {
      statusString = "rejected";
      actionLogString = "Rejected document";
    } else if (action === "request_changes") {
      if (!comments) {
         return res.status(400).json({ success: false, message: "Comment is required when requesting changes" });
      }
      statusString = "changes_requested";
      actionLogString = "Requested changes";
    }

    // Update Document
    doc.status = statusString;
    if (action === "approve") {
      doc.approvedBy = req.user.id;
      doc.approvedAt = new Date();
    } else if (action === "reject") {
      doc.rejectionReason = comments || "";
    } else if (action === "request_changes") {
      doc.reviewComment = comments || "";
    }
    await doc.save();

    // Update Approval if it exists
    if (approval) {
      approval.status = statusString;
      approval.reviewedBy = req.user.id;
      approval.comments = comments || "";
      await approval.save();
    }

    // Log Activity
    await Activity.create({
      user: req.user.id,
      action: actionLogString,
      entityType: "Document",
      entityName: doc.fileName,
      comment: comments || ""
    });

    res.json({ success: true, status: statusString });
  } catch (error) {
    console.error("MAKE DECISION ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
