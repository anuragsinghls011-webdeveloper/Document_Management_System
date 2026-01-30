const Document = require("../models/document.model");

exports.stats = async (req, res) => {
  const total = await Document.countDocuments({ userId: req.user.userId });
  const approved = await Document.countDocuments({ status: "approved" });
  const pending = await Document.countDocuments({ status: "pending" });

  res.json({
    totalDocuments: total,
    approvedDocuments: approved,
    pendingDocuments: pending
  });
};
