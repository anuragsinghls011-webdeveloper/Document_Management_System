const mongoose = require("mongoose");
const Document = require("../models/document.model");
const Workflow = require("../models/workflow.model");
const Activity = require("../models/activity.model");

exports.getAnalyticsData = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    // 1. Total Uploads
    const totalUploads = await Document.countDocuments({ userId });

    // 2. Active Workflows
    const activeWorkflows = await Workflow.countDocuments({ createdBy: userId, status: "Published" });

    // 3. Storage Efficiency (mocked based on standard compression rates)
    const storageEfficiency = 92.4; 

    // 4. Processing Errors
    const processingErrors = await Document.countDocuments({ userId, status: "rejected" });

    // 5. AI Value Metrics
    const docsWithSummary = await Document.countDocuments({ userId, summary: { $ne: "", $exists: true } });
    const docsApproved = await Document.countDocuments({ userId, status: "approved" });
    const docsPending = await Document.countDocuments({ userId, status: { $in: ["pending", "review", "processing"] } });
    
    const timeSavedHours = Math.round((totalUploads * 15) / 60); // Assuming 15 mins saved per doc
    const autoApprovalRate = totalUploads > 0 ? ((docsApproved / totalUploads) * 100).toFixed(1) : 0;
    const averageConfidence = 96.8; // Mocked AI confidence score

    // 6. Top Extracted Keywords
    const topKeywordsAgg = await Document.aggregate([
      { $match: { userId } },
      { $unwind: "$keywords" },
      { $group: { _id: "$keywords", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 6 }
    ]);
    
    const topKeywordsLabels = topKeywordsAgg.map(k => k._id);
    const topKeywordsData = topKeywordsAgg.map(k => k.count);

    // 7. Upload Trends (Last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const uploadsAgg = await Document.aggregate([
      { $match: { userId, createdAt: { $gte: sixMonthsAgo } } },
      { $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          count: { $sum: 1 }
      }}
    ]);

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const uploadsDataMap = {};
    uploadsAgg.forEach(item => {
      uploadsDataMap[`${item._id.year}-${item._id.month}`] = item.count;
    });

    const uploadsLabels = [];
    const uploadsData = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      uploadsLabels.push(monthNames[d.getMonth()]);
      uploadsData.push(uploadsDataMap[key] || 0);
    }

    // 8. Documents by Type
    const typeAgg = await Document.aggregate([
      { $match: { userId } },
      { $group: { _id: "$fileType", count: { $sum: 1 } } }
    ]);

    const typesMap = { pdf: 0, doc: 0, img: 0, spreadsheet: 0, other: 0 };
    typeAgg.forEach(t => {
      const ext = (t._id || "").toLowerCase();
      if (ext === "pdf") typesMap.pdf += t.count;
      else if (["doc", "docx"].includes(ext)) typesMap.doc += t.count;
      else if (["png", "jpg", "jpeg", "webp"].includes(ext)) typesMap.img += t.count;
      else if (["xls", "xlsx", "csv"].includes(ext)) typesMap.spreadsheet += t.count;
      else typesMap.other += t.count;
    });
    
    // 9. User Activity by Day (Last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0,0,0,0);
    
    const activityAgg = await Activity.aggregate([
      { $match: { user: userId, createdAt: { $gte: sevenDaysAgo } } },
      { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
      }}
    ]);

    const activityMap = {};
    activityAgg.forEach(a => { activityMap[a._id] = a.count; });

    const activityLabels = [];
    const activityData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      activityLabels.push(dayName);
      activityData.push(activityMap[dateStr] || 0);
    }

    // 10. Workflow Status Breakdown
    const workflowStatusAgg = await Workflow.aggregate([
      { $match: { createdBy: userId } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);
    
    const workflowStatusMap = { Published: 0, Draft: 0, Archived: 0 };
    workflowStatusAgg.forEach(w => {
      if (workflowStatusMap[w._id] !== undefined) {
          workflowStatusMap[w._id] = w.count;
      }
    });

    res.json({
      stats: {
        totalUploads,
        activeWorkflows,
        storageEfficiency,
        processingErrors,
        timeSavedHours,
        autoApprovalRate,
        averageConfidence,
        docsWithSummary
      },
      charts: {
        uploads: {
          labels: uploadsLabels,
          data: uploadsData
        },
        docsType: {
          labels: ['PDFs', 'Word Docs', 'Images', 'Spreadsheets', 'Other'],
          data: [typesMap.pdf, typesMap.doc, typesMap.img, typesMap.spreadsheet, typesMap.other]
        },
        userActivity: {
          labels: activityLabels,
          data: activityData
        },
        workflowStatus: {
          labels: ['Published', 'Draft', 'Archived'],
          data: [workflowStatusMap.Published, workflowStatusMap.Draft, workflowStatusMap.Archived]
        },
        topKeywords: {
          labels: topKeywordsLabels,
          data: topKeywordsData
        },
        processingStatus: {
          labels: ['Approved', 'Pending', 'Rejected'],
          data: [docsApproved, docsPending, processingErrors]
        }
      }
    });

  } catch (error) {
    console.error("ANALYTICS STATS ERROR:", error);
    res.status(500).json({ message: "Failed to load analytics data" });
  }
};
