const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/workflows.controller");

// Page Route (EJS View)
router.get("/workflows", auth, controller.renderBuilder);

// API Routes
router.post("/api/workflows", auth, controller.createWorkflow);
router.get("/api/workflows", auth, controller.getWorkflows);
router.get("/api/workflows/:id", auth, controller.getWorkflow);
router.put("/api/workflows/:id", auth, controller.updateWorkflow);
router.delete("/api/workflows/:id", auth, controller.deleteWorkflow);
router.post("/api/workflows/:id/publish", auth, controller.publishWorkflow);
router.post("/api/workflows/:id/execute", auth, controller.executeWorkflow);

module.exports = router;