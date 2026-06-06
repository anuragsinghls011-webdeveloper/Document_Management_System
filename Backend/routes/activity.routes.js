const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const Activity = require("../models/activity.model");

router.get("/activities/recent", auth, async (req, res) => {
  try {
    const activities = await Activity.find()
      .populate("user", "username")
      .sort({ createdAt: -1 })
      .limit(5);

    res.json(activities);
  } catch (err) {
    res.status(500).json({ message: "Failed to load activity" });
  }
});
router.post("/activities", auth, async (req, res) => {
  try {
    const { type, details } = req.body;
    const activity = new Activity({ type, details, user: req.user.id });
    await activity.save();
    res.status(201).json(activity);
  } catch (err) {
    res.status(400).json({ message: "Failed to create activity" });
  }
});
module.exports = router;
