const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analytics.controller');
const auth = require('../middlewares/auth.middleware');

router.get('/data', auth, analyticsController.getAnalyticsData);

module.exports = router;
