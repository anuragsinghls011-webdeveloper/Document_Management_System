const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const roleAuth = require("../middlewares/role.middleware");
const approvalsController = require("../controllers/approvals.controller");

// Only admins and GMs can access the approvals queue API
router.use(auth);
router.use(roleAuth(["admin", "GM"]));

router.get("/pending", approvalsController.getPendingApprovals);
router.post("/:id/decision", approvalsController.makeDecision);

module.exports = router;
