const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    action: {
      type: String,
      required: true
      
    },
    entityType: {
      type: String
      
    },
    entityName: {
      type: String
      
    },
    comment: {
      type: String
    }
  },
  { timestamps: true }
);

activitySchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Activity", activitySchema);
