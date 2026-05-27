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

module.exports = mongoose.model("Document", documentSchema);
