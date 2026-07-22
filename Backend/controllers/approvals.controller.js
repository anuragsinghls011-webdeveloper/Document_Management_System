const mongoose = require("mongoose");
const Approval = require("../models/approval.model");
const Document = require("../models/document.model");
const Activity = require("../models/activity.model");
const { getRoleForDepartment, DEPARTMENT_ROLE_MAP } = require("../services/ai.service");

// Fetch pending approvals
// Department managers only see documents routed to their department
exports.getPendingApprovals = async (req, res) => {
  try {
    const userRole = req.userRole || req.user.role;
    const userId = req.user.id;

    let query = { status: "pending" };

    // If user is not admin, filter to show only documents routed to them
    if (userRole !== "admin") {
      // Find departments this role manages
      const managedDepts = Object.entries(DEPARTMENT_ROLE_MAP)
        .filter(([, role]) => role === userRole)
        .map(([dept]) => dept);

      if (managedDepts.length > 0) {
        // Show docs routed to this user OR docs in their managed departments
        query.$or = [
          { routedTo: new mongoose.Types.ObjectId(userId) },
          { department: { $in: managedDepts } }
        ];
      } else {
        // General manager or roles not in the map — show docs routed to them
        query.routedTo = new mongoose.Types.ObjectId(userId);
      }
    }

    const pendingDocs = await Document.find(query)
      .populate("userId", "username email")
      .populate("routedTo", "username email role")
      .sort({ createdAt: -1 });

    // Format the response to include AI analysis fields
    const documents = pendingDocs.map(doc => ({
        _id: doc._id,
        fileName: doc.fileName,
        fileType: doc.fileType,
        createdAt: doc.createdAt,
        userId: doc.userId,
        status: doc.status,
        summary: doc.summary,
        keywords: doc.keywords,
        documentType: doc.documentType || "Unknown",
        department: doc.department || "General",
        aiSummary: doc.aiSummary || doc.summary || "",
        confidence: doc.confidence || 0,
        routedTo: doc.routedTo ? {
          _id: doc.routedTo._id,
          username: doc.routedTo.username,
          email: doc.routedTo.email,
          role: doc.routedTo.role
        } : null
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
