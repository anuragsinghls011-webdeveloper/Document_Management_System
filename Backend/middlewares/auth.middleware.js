const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).send("No token");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: decoded.userId
    };
    req.userRole = decoded.role;
    res.locals.userRole = decoded.role;

    next();
  } catch (err) {
    console.error("AUTH ERROR ", err);
    res.status(401).send("Invalid token");
  }
};
