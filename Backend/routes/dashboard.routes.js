const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const { stats } = require("../controllers/dashboard.controller");

router.get("/stats", auth, stats);

module.exports = router;
