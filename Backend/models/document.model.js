const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    fileName: {
      type: String,
      required: true
    },

    fileType: {
      type: String
    },

    filePath: {
      type: String,
      required: true
    },

    extractedText: {
      type: String,
      default: ""
    },

    summary: {
      type: String,
      default: ""
    },

    keywords: {
      type: [String],
      default: []
    },

    documentType: {
      type: String,
      default: ""
    },

    department: {
      type: String,
      default: ""
    },

    aiSummary: {
      type: String,
      default: ""
    },

    routedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },

    confidence: {
      type: Number,
      default: 0
    },

    status: {
      type: String,
      enum: ["pending", "processing", "review", "approved", "rejected", "changes_requested", "archived"],
      default: "pending"
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },

    approvedAt: {
      type: Date
    },

    rejectionReason: {
      type: String
    },

    reviewComment: {
      type: String
    }
  },
  {
    timestamps: true
  }
);

documentSchema.index({
  fileName: "text",
  extractedText: "text",
  summary: "text",
  keywords: "text"
});

documentSchema.index({ userId: 1, createdAt: -1 });
documentSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Document", documentSchema);
