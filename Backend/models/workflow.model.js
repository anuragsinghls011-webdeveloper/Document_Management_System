const mongoose = require("mongoose");

const nodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  type: { type: String, required: true },
  position: {
    x: { type: Number, required: true },
    y: { type: Number, required: true }
  },
  data: { type: mongoose.Schema.Types.Mixed }, // Configuration for the node
  width: Number,
  height: Number,
  selected: Boolean,
  positionAbsolute: {
    x: Number,
    y: Number
  },
  dragging: Boolean
}, { _id: false });

const edgeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },
  sourceHandle: String,
  targetHandle: String,
  type: String,
  animated: Boolean,
  data: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const workflowSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: "" },
  version: { type: Number, default: 1 },
  status: { 
    type: String, 
    enum: ["Draft", "Published", "Archived"], 
    default: "Draft" 
  },
  nodes: [nodeSchema],
  edges: [edgeSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
}, { timestamps: true });

module.exports = mongoose.model("Workflow", workflowSchema);
