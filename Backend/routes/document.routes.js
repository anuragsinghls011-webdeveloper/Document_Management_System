const express = require("express");

const auth = require("../middlewares/auth.middleware");
const upload = require("../middlewares/upload.middleware");
const controller = require("../controllers/document.controller");

const router = express.Router();

router.post("/upload", auth, upload.array("documents", 100), controller.upload);
router.get("/", auth, controller.getDocuments);
router.get("/my", auth, controller.myDocuments);
router.get("/stats", auth, controller.stats);
router.get("/search", auth, controller.search);
router.get("/recent", auth, controller.recent);

router.get("/:id/view", auth, controller.viewDocument);
router.get("/:id/download", auth, controller.downloadDocument);
router.delete("/:id", auth, controller.deleteDocument);

module.exports = router;
