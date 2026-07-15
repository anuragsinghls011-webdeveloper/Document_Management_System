const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth.middleware');
const upload = require('../middlewares/upload.middleware');
const controller = require('../controllers/document.controller');


// Render documents listing page
router.get('/', auth, (req, res) => {
  res.render('documents');
});

// Render documents page for a specific document (client-side will handle details)
router.get('/:id', auth, (req, res) => {
  res.render('documents');
});
router.post("/upload", auth, upload.array("documents", 100), controller.upload);


router.get("/", auth, controller.getDocuments);
router.get("/my", auth, controller.myDocuments);
router.get("/stats", auth, controller.stats);
router.get("/search", auth, controller.search);
router.get("/recent", auth, controller.recent);
router.post("/upload", auth, upload.array("documents", 100), controller.upload);
                                                                                        
module.exports = router;