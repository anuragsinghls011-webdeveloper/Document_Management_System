const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth.middleware');

// Render documents listing page
router.get('/', auth, (req, res) => {
  res.render('documents');
});

// Render documents page for a specific document (client-side will handle details)
router.get('/:id', auth, (req, res) => {
  res.render('documents');
});

module.exports = router;
