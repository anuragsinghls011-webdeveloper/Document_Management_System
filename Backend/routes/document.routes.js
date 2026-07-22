const express = require("express");

const auth = require("../middlewares/auth.middleware");
const checkRole = require("../middlewares/role.middleware");
const upload = require("../middlewares/upload.middleware");
const controller = require("../controllers/document.controller");

const router = express.Router();

router.post("/upload", auth, checkRole(["admin", "editor", "financeManager", "hrManager", "generalManager"]), upload.array("documents", 1000), controller.upload);
router.get("/", auth, controller.getDocuments);
router.get("/my", auth, controller.myDocuments);
router.get("/stats", auth, controller.stats);
router.get("/search", auth, controller.search);
router.get("/recent", auth, controller.recent);
router.post("/reanalyze", auth, checkRole(["admin", "generalManager"]), controller.reanalyzeAll);

router.get("/:id/view", auth, controller.viewDocument);
router.get("/:id/download", auth, controller.downloadDocument);
router.get("/:id/analysis", auth, controller.getAnalysis);
router.post("/:id/reanalyze", auth, controller.reanalyzeSingle);
router.delete("/:id", auth, checkRole(["admin", "generalManager"]), controller.deleteDocument);

module.exports = router;

