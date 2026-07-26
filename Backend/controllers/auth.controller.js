// NOTE: This controller is NOT currently used. Auth is handled inline in routes/user.routes.js.
// auth.routes.js imports these but is never mounted in app.js.
const User = require("../models/user.model");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

exports.register = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingUser = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username }]
    });

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hash = await bcrypt.hash(password, 10);
    await User.create({ username, email: email.toLowerCase(), password: hash });

    res.json({ message: "User registered" });
  } catch (error) {
    console.error("AUTH REGISTER ERROR:", error);
    res.status(500).json({ message: "Registration failed" });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.cookie("token", token, { httpOnly: true, sameSite: "lax" });
    res.json({ message: "Login successful" });
  } catch (error) {
    console.error("AUTH LOGIN ERROR:", error);
    res.status(500).json({ message: "Login failed" });
  }
};
