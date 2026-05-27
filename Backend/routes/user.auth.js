const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
  const bearerToken = req.header("Authorization");
  const token = bearerToken?.startsWith("Bearer ")
    ? bearerToken.slice(7)
    : bearerToken || req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: decoded.userId,
      role: decoded.role
    };
    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
};

module.exports = authMiddleware;
