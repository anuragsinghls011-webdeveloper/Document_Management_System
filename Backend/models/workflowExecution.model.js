const mongoose = require("mongoose");

const workflowExecutionSchema = new mongoose.Schema({
  workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow", required: true },
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: false },
  status: { 
    type: String, 
    enum: ["Pending", "Running", "Completed", "Failed", "Paused"], 
    default: "Pending" 
  },
  currentNodeId: { type: String },
  state: { type: mongoose.Schema.Types.Mixed, default: {} }, // Global state for execution variables
  logs: [{
    nodeId: String,
    status: { type: String, enum: ["Success", "Failure", "Pending", "Skipped"] },
    message: String,
    timestamp: { type: Date, default: Date.now },
    data: mongoose.Schema.Types.Mixed
  }],
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model("WorkflowExecution", workflowExecutionSchema);
