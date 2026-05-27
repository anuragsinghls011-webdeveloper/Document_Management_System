const Document = require("../models/document.model");

exports.stats = async (req, res) => {
  try {
    const userId = req.user.id;
    const total = await Document.countDocuments({ userId });
    const approved = await Document.countDocuments({ userId, status: "approved" });
    const pending = await Document.countDocuments({ userId, status: "pending" });

    res.json({
      totalDocuments: total,
      approvedDocuments: approved,
      pendingDocuments: pending
    });
  } catch (error) {
    console.error("DASHBOARD STATS ERROR:", error);
    res.status(500).json({ message: "Failed to load dashboard stats" });
  }
};
