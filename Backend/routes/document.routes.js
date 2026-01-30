const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");

const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/document.controller");




const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } 
});


router.post(
  "/upload",
  auth,
  upload.array("documents", 10),
  controller.upload
);
router.get("/files", async (req, res) => {
  const { status, type, date } = req.query;

  let filter = {};

  if (status) filter.status = status;
  if (type) filter.type = type;

  if (date) {
    const start = new Date(date);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    filter.createdAt = { $gte: start, $lte: end };
  }

  const files = await File.find(filter).sort({ createdAt: -1 });

  res.render("files", {
    files,
    filters: req.query
  });
});

router.post("/upload", auth, upload.array("documents", 10), controller.upload);
router.get("/my", auth, controller.myDocuments);
router.get("/stats", auth, controller.stats);
router.get("/search", auth, controller.search);
router.get("/recent", controller.recent);

router.get("/my", auth, controller.myDocuments);

module.exports = router;
