const Document = require("../models/document.model");
const Activity = require("../models/activity.model");

// 🔹 Fetch pending documents
exports.pendingDocs = async (req, res) => {
  try {
    const pendingDocs = await Document.find({ status: "Pending" })
      .populate("uploadedBy", "username email")
      .sort({ createdAt: -1 });

    res.json({ success: true, documents: pendingDocs });
  } catch (error) {
    console.error("PENDING DOCS ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// 🔹 Fetch single document
exports.getDocument = async (req, res) => {
  const doc = await Document.findById(req.params.id)
    .populate("uploadedBy", "username email");

  res.json(doc);
};

// 🔹 Approve
exports.approveDoc = async (req, res) => {
  const doc = await Document.findByIdAndUpdate(
    req.params.id,
    { status: "Approved" },
    { new: true }
  );

  await Activity.create({
    user: req.userId,
    action: "Approved document",
    entityType: "Document",
    entityName: doc.title
  });

  res.json({ success: true, status: "Approved" });
};

// 🔹 Reject
exports.rejectDoc = async (req, res) => {
  const { comment } = req.body;

  const doc = await Document.findByIdAndUpdate(
    req.params.id,
    { status: "Rejected" },
    { new: true }
  );

  await Activity.create({
    user: req.userId,
    action: "Rejected document",
    entityType: "Document",
    entityName: doc.title,
    comment
  });

  res.json({ success: true, status: "Rejected" });
};

// 🔹 Request changes
exports.requestChanges = async (req, res) => {
  const { comment } = req.body;

  const doc = await Document.findByIdAndUpdate(
    req.params.id,
    { status: "Changes Requested" },
    { new: true }
  );

  await Activity.create({
    user: req.userId,
    action: "Requested changes",
    entityType: "Document",
    entityName: doc.title,
    comment
  });

  res.json({ success: true, status: "Changes Requested" });
};
exports.requestChanges = async (req, res) => {
  try {
    const { comment } = req.body;
    const { id } = req.params;

    // ❌ Comment mandatory
    if (!comment || comment.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Comment is required when requesting changes"
      });
    }

    // 🔍 Find document
    const doc = await Document.findById(id);

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Document not found"
      });
    }

    // 📝 Update status
    doc.status = "Changes Requested";
    doc.reviewComment = comment; // optional field
    await doc.save();

    // 📜 Activity log
    await Activity.create({
      user: req.userId,
      action: "Requested changes",
      entityType: "Document",
      entityName: doc.title,
      comment: comment
    });

    return res.json({
      success: true,
      status: "Changes Requested",
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
