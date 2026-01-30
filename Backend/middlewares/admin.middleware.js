module.exports = (req, res, next) => {
  console.log("ROLE CHECK ", req.userRole);

  if (req.userRole !== "admin") {
    return res.status(403).json({ message: "Admin access only" });
  }

  next();
};
