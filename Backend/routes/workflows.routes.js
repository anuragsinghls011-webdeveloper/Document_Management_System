const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const roleAuth = require("../middlewares/role.middleware");
const controller = require("../controllers/workflows.controller");
const { validateMongoId, validateWorkflowCreate, validateWorkflowUpdate } = require("../middlewares/validators");

// Apply authentication and role authorization to all workflow routes
router.use("/workflows", auth, roleAuth(["admin", "GM"]));
router.use("/api/workflows", auth, roleAuth(["admin", "GM"]));

// Page Route (EJS View)
router.get("/workflows", controller.renderBuilder);

// API Routes
router.post("/api/workflows", validateWorkflowCreate, controller.createWorkflow);
router.get("/api/workflows", controller.getWorkflows);
router.get("/api/workflows/:id", validateMongoId, controller.getWorkflow);
router.put("/api/workflows/:id", validateWorkflowUpdate, controller.updateWorkflow);
router.delete("/api/workflows/:id", validateMongoId, controller.deleteWorkflow);
router.post("/api/workflows/:id/publish", validateMongoId, controller.publishWorkflow);
router.post("/api/workflows/:id/execute", validateMongoId, controller.executeWorkflow);

module.exports = router;