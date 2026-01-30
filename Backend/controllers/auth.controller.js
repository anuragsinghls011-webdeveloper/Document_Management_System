const User = require("../models/user.model");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

exports.register = async (req, res) => {
  const { username, email, password } = req.body;

  const hash = await bcrypt.hash(password, 10);
  await User.create({ username, email, password: hash });

  res.json({ message: "User registered" });
};

exports.login = async (req, res) => {
   const { email, password } = req.body;

   const user = await User.findOne({ email });
   if (!user) return res.status(400).json({ message: "Invalid credentials" });

   const match = await bcrypt.compare(password, user.password);
   if (!match) return res.status(400).json({ message: "Invalid credentials" });

   console.log("LOGIN DEBUG - User found:", user);
   console.log("LOGIN DEBUG - User role:", user.role);

   const token = jwt.sign(
     { userId: user._id,role: user.role },
     process.env.JWT_SECRET,
     { expiresIn: "1h" }
   );

   res.cookie("token", token, { httpOnly: true });
   res.json({ message: "Login successful" });
};
