const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const roleAuth = require("../middlewares/role.middleware");
const controller = require("../controllers/workflows.controller");

// Apply authentication and role authorization to all workflow routes
router.use("/workflows", auth, roleAuth(["admin", "GM"]));
router.use("/api/workflows", auth, roleAuth(["admin", "GM"]));

// Page Route (EJS View)
router.get("/workflows", controller.renderBuilder);

// API Routes
router.post("/api/workflows", controller.createWorkflow);
router.get("/api/workflows", controller.getWorkflows);
router.get("/api/workflows/:id", controller.getWorkflow);
router.put("/api/workflows/:id", controller.updateWorkflow);
router.delete("/api/workflows/:id", controller.deleteWorkflow);
router.post("/api/workflows/:id/publish", controller.publishWorkflow);
router.post("/api/workflows/:id/execute", controller.executeWorkflow);

module.exports = router;