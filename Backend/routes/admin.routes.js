const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const adminOnly = require("../middlewares/admin.middleware");
const adminController = require("../controllers/admin.controller");

router.get("/pending", auth, adminOnly, adminController.pendingDocs);
router.post("/approve/:id", auth, adminOnly, adminController.approveDoc);
router.post("/reject/:id", auth, adminOnly, adminController.rejectDoc);
router.post("/request-changes/:id", auth, adminOnly, adminController.requestChanges);

module.exports = router;
