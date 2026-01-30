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

    // AI extracted data
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

    // Approval workflow
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
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
    }
  },
  {
    timestamps: true // createdAt & updatedAt automatically
  }
);

// Full text search
documentSchema.index({
  fileName: "text",
  extractedText: "text",
  summary: "text",
  keywords: "text"
});

module.exports = mongoose.model("Document", documentSchema);
