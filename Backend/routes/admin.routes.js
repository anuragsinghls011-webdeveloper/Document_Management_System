const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const adminOnly = require("../middlewares/admin.middleware");
const adminController = require("../controllers/admin.controller");
const { validateMongoId, validateAdminReject, validateAdminRequestChanges } = require("../middlewares/validators");

router.get("/pending", auth, adminOnly, adminController.pendingDocs);
router.get("/document/:id", auth, adminOnly, validateMongoId, adminController.getDocument);
router.post("/approve/:id", auth, adminOnly, validateMongoId, adminController.approveDoc);
router.post("/reject/:id", auth, adminOnly, validateAdminReject, adminController.rejectDoc);
router.post("/request-changes/:id", auth, adminOnly, validateAdminRequestChanges, adminController.requestChanges);

module.exports = router;
