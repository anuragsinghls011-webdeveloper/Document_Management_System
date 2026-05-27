const express = require("express");
const fs = require("fs");
const multer = require("multer");
const path = require("path");

const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/document.controller");

const router = express.Router();
const uploadDir = path.join(__dirname, "..", "uploads");

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post("/upload", auth, upload.array("documents", 100), controller.upload);
router.get("/my", auth, controller.myDocuments);
router.get("/stats", auth, controller.stats);
router.get("/search", auth, controller.search);
router.get("/recent", auth, controller.recent);

module.exports = router;
