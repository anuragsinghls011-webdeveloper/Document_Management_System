const Workflow = require("../models/workflow.model");
const WorkflowExecution = require("../models/workflowExecution.model");
const WorkflowEngine = require("../services/workflow.engine");

// Render the Workflow Builder Page
exports.renderBuilder = async (req, res) => {
  res.render("workflows", { title: "Workflow Builder" });
};

// API: Create a new workflow
exports.createWorkflow = async (req, res) => {
  try {
    const { name, description, nodes, edges } = req.body;
    const workflow = new Workflow({
      name: name || "Untitled Workflow",
      description,
      nodes: nodes || [],
      edges: edges || [],
      createdBy: req.user ? req.user.id : null
    });
    await workflow.save();
    res.status(201).json({ success: true, workflow });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// API: Get all workflows
exports.getWorkflows = async (req, res) => {
  try {
    const workflows = await Workflow.find().sort("-createdAt");
    res.json({ success: true, workflows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// API: Get single workflow
exports.getWorkflow = async (req, res) => {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ success: false, message: "Workflow not found" });
    res.json({ success: true, workflow });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// API: Update workflow (save design)
exports.updateWorkflow = async (req, res) => {
  try {
    const { name, description, nodes, edges } = req.body;
    const workflow = await Workflow.findByIdAndUpdate(
      req.params.id, 
      { name, description, nodes, edges },
      { new: true }
    );
    if (!workflow) return res.status(404).json({ success: false, message: "Workflow not found" });
    res.json({ success: true, workflow });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// API: Delete workflow
exports.deleteWorkflow = async (req, res) => {
  try {
    await Workflow.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Workflow deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// API: Publish workflow
exports.publishWorkflow = async (req, res) => {
  try {
    const workflow = await Workflow.findByIdAndUpdate(req.params.id, { status: "Published" }, { new: true });
    res.json({ success: true, workflow });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// API: Execute workflow
exports.executeWorkflow = async (req, res) => {
  try {
    const workflowId = req.params.id;
    const workflow = await Workflow.findById(workflowId);
    
    if (!workflow) return res.status(404).json({ success: false, message: "Workflow not found" });
    if (workflow.status !== "Published") {
      // Allow execution for testing even if Draft, but typically we want Published
    }

    const execution = new WorkflowExecution({
      workflowId: workflow._id,
      state: req.body.state || {}
    });
    await execution.save();

    const engine = new WorkflowEngine(execution._id);
    // Start engine in background so API responds immediately
    engine.start().catch(console.error);

    res.json({ success: true, executionId: execution._id, message: "Execution started" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
