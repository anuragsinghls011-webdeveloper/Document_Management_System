const Document = require("../models/document.model");
const Activity = require("../models/activity.model");

<<<<<<< HEAD
=======
//  Fetch pending documents
>>>>>>> d01f47e50e3f8e6132207dc22b657c309df604b9
exports.pendingDocs = async (req, res) => {
  try {
    const pendingDocs = await Document.find({ status: "pending" })
      .populate("userId", "username email")
      .sort({ createdAt: -1 });

    res.json({ success: true, documents: pendingDocs });
  } catch (error) {
    console.error("PENDING DOCS ERROR:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

<<<<<<< HEAD
=======
//  Fetch single document
>>>>>>> d01f47e50e3f8e6132207dc22b657c309df604b9
exports.getDocument = async (req, res) => {
  try {
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

<<<<<<< HEAD
=======
//  Approve
>>>>>>> d01f47e50e3f8e6132207dc22b657c309df604b9
exports.approveDoc = async (req, res) => {
  try {
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

<<<<<<< HEAD
=======
//  Reject
>>>>>>> d01f47e50e3f8e6132207dc22b657c309df604b9
exports.rejectDoc = async (req, res) => {
  try {
    const { reason, comment } = req.body;
    const rejectionReason = reason || comment || "";
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

<<<<<<< HEAD
=======
//  Request changes
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
>>>>>>> d01f47e50e3f8e6132207dc22b657c309df604b9
exports.requestChanges = async (req, res) => {
  try {
    const { comment } = req.body;

<<<<<<< HEAD
=======
    //  Comment mandatory
>>>>>>> d01f47e50e3f8e6132207dc22b657c309df604b9
    if (!comment || comment.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Comment is required when requesting changes"
      });
    }

<<<<<<< HEAD
    const doc = await Document.findById(req.params.id);
=======
    //  Find document
    const doc = await Document.findById(id);
>>>>>>> d01f47e50e3f8e6132207dc22b657c309df604b9

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Document not found"
      });
    }

<<<<<<< HEAD
    doc.status = "changes_requested";
    doc.reviewComment = comment.trim();
    await doc.save();

=======
    //  Update status
    doc.status = "Changes Requested";
    doc.reviewComment = comment; // optional field
    await doc.save();

    
>>>>>>> d01f47e50e3f8e6132207dc22b657c309df604b9
    await Activity.create({
      user: req.user.id,
      action: "Requested changes",
      entityType: "Document",
      entityName: doc.fileName,
      comment: comment.trim()
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
