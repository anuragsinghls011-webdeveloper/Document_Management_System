const Workflow = require("../models/workflow.model");
const WorkflowExecution = require("../models/workflowExecution.model");

class WorkflowEngine {
  constructor(executionId) {
    this.executionId = executionId;
  }

  async start() {
    const execution = await WorkflowExecution.findById(this.executionId).populate("workflowId");
    if (!execution) throw new Error("Execution not found");

    const workflow = execution.workflowId;
    if (!workflow) throw new Error("Workflow not found");

    // Find Start node
    const startNode = workflow.nodes.find(n => n.type === "startNode" || (n.data && n.data.type === "start"));
    if (!startNode) {
      return this.failExecution(execution, "No Start node found");
    }

    execution.status = "Running";
    execution.currentNodeId = startNode.id;
    await execution.save();

    return this.executeNode(execution, workflow, startNode);
  }

  async executeNode(execution, workflow, node) {
    if (!node) {
      return this.completeExecution(execution);
    }

    try {
      execution.currentNodeId = node.id;
      
      // Simulate node execution logic based on node type
      let status = "Success";
      let message = `Executed ${node.data?.label || node.type}`;

      const nodeType = node.data?.type || node.type;

      switch (nodeType) {
        case "approvalNode":
        case "approval":
          // Approvals wait for external input. Mark as pending.
          status = "Pending";
          message = "Waiting for approval";
          execution.status = "Paused"; // Pause execution
          break;
        case "delayNode":
        case "delay":
          status = "Pending";
          message = "Delay started";
          execution.status = "Paused";
          break;
        case "endNode":
        case "end":
          return this.completeExecution(execution);
        default:
          // Simulate some processing time for standard nodes
          await new Promise(resolve => setTimeout(resolve, 500));
          break;
      }

      // Log execution
      execution.logs.push({
        nodeId: node.id,
        status,
        message,
        data: node.data
      });

      await execution.save();

      if (status === "Success") {
        const nextNode = this.getNextNode(workflow, node.id);
        if (nextNode) {
          return this.executeNode(execution, workflow, nextNode);
        } else {
          return this.completeExecution(execution);
        }
      }
      
      return execution;

    } catch (error) {
      return this.failExecution(execution, error.message);
    }
  }

  getNextNode(workflow, currentNodeId) {
    const edge = workflow.edges.find(e => e.source === currentNodeId);
    if (!edge) return null;
    return workflow.nodes.find(n => n.id === edge.target);
  }

  async completeExecution(execution) {
    execution.status = "Completed";
    execution.completedAt = new Date();
    execution.currentNodeId = null;
    execution.logs.push({
      nodeId: "system",
      status: "Success",
      message: "Workflow completed successfully"
    });
    await execution.save();
    return execution;
  }

  async failExecution(execution, reason) {
    execution.status = "Failed";
    execution.completedAt = new Date();
    execution.logs.push({
      nodeId: execution.currentNodeId || "system",
      status: "Failure",
      message: reason
    });
    await execution.save();
    return execution;
  }
}

module.exports = WorkflowEngine;
