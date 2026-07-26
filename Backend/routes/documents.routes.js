const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth.middleware');
const upload = require('../middlewares/upload.middleware');
const controller = require('../controllers/document.controller');


// Render documents listing page
router.get('/', auth, (req, res) => {
  res.render('documents', { userRole: req.userRole });
});

// Render documents page for a specific document (client-side will handle details)
router.get('/:id', auth, (req, res) => {
  res.render('documents', { userRole: req.userRole });
});

module.exports = router;