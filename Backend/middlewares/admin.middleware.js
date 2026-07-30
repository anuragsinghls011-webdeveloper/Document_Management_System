const User = require("../models/user.model");
const logger = require("../config/logger").createChildLogger("AdminAuth");

module.exports = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const user = await User.findById(req.user.id).select("role");

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.userRole = user.role;

    if (user.role !== "admin") {
      return res.status(403).json({ message: "Admin access only" });
    }

    next();
  } catch (error) {
    logger.error("Admin auth error", { error: error.message });
    return res.status(500).json({ message: "Failed to verify admin access" });
  }
};
