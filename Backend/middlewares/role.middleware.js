module.exports = (allowedRoles) => {
  return (req, res, next) => {
    try {
      if (!req.userRole) {
        return res.status(401).json({ message: "Authentication required" });
      }

      if (!allowedRoles.includes(req.userRole)) {
        return res.status(403).json({ message: "Forbidden: You do not have the required role to perform this action." });
      }

      next();
    } catch (error) {
      console.error("ROLE AUTH ERROR", error);
      return res.status(500).json({ message: "Failed to verify access" });
    }
  };
};
