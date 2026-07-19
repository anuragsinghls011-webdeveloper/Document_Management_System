const mongoose = require("mongoose");
const Document = require("../models/document.model");

exports.stats = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const isAdmin = req.userRole === "admin";
    const baseQuery = isAdmin ? {} : { userId };
    
    const [total, today, pending, rejected, recentDocs, typeAgg] = await Promise.all([
      Document.countDocuments({ ...baseQuery }),
      Document.countDocuments({
        ...baseQuery,
        createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
      }),
      Document.countDocuments({ ...baseQuery, status: { $in: ["pending", "review"] } }),
      Document.countDocuments({ ...baseQuery, status: "rejected" }),
      Document.find({ ...baseQuery }).sort({ createdAt: -1 }).limit(5),
      Document.aggregate([
        { $match: isAdmin ? {} : { userId } },
        { $group: { _id: "$fileType", count: { $sum: 1 } } }
      ])
    ]);
    
    const accuracy = total > 0 ? (((total - rejected) / total) * 100).toFixed(1) : 100;
    
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 6);
    sevenDaysAgo.setHours(0,0,0,0);
    
    const volumeAgg = await Document.aggregate([
      { $match: { ...(isAdmin ? {} : { userId }), createdAt: { $gte: sevenDaysAgo } } },
      { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
      }}
    ]);
    
    const volumeMap = {};
    volumeAgg.forEach(v => { volumeMap[v._id] = v.count; });
    
    const volumeLabels = [];
    const volumeData = [];
    
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      volumeLabels.push(dayName);
      volumeData.push(volumeMap[dateStr] || 0);
    }

    // Format types for the doughnut chart
    const typesMap = {
      pdf: 0, doc: 0, docx: 0, img: 0, other: 0
    };
    
    typeAgg.forEach(t => {
      const ext = (t._id || "").toLowerCase();
      if (ext === "pdf") typesMap.pdf += t.count;
      else if (["doc", "docx"].includes(ext)) typesMap.doc += t.count;
      else if (["png", "jpg", "jpeg", "webp"].includes(ext)) typesMap.img += t.count;
      else typesMap.other += t.count;
    });

    const typesData = {
      labels: ['PDFs', 'Word Docs', 'Images', 'Other'],
      data: [typesMap.pdf, typesMap.doc, typesMap.img, typesMap.other]
    };

    res.json({
      totalDocuments: total,
      processedToday: today,
      pendingReview: pending,
      accuracy: accuracy,
      recentDocuments: recentDocs,
      volume: {
        labels: volumeLabels,
        data: volumeData
      },
      types: typesData
    });
  } catch (error) {
    console.error("DASHBOARD STATS ERROR:", error);
    res.status(500).json({ message: "Failed to load dashboard stats" });
  }
};
