const jwt = require("jsonwebtoken");
const User = require("../models/user.model");

module.exports = async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).send("No token");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Fetch full user from database
    const user = await User.findById(decoded.userId).select("-password");
    if (!user) {
      return res.status(401).send("User not found");
    }

    req.user = {
      id: user._id.toString()
    };
    req.userRole = user.role;
    
    // Set for EJS templates
    res.locals.userRole = user.role;
    res.locals.user = user;

    next();
  } catch (err) {
    console.error("AUTH ERROR ", err);
    res.status(401).send("Invalid token");
  }
};
