const express = require('express');
const router = (express.Router());
const { body, validationResult } = require('express-validator');
const User = require('../models/user.model');
const Activity = require("../models/activity.model");
const bcrypt = require('bcrypt');
const jwt=require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

const isProduction = process.env.NODE_ENV === "production";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again later." }
});

function getCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    maxAge: 24 * 60 * 60 * 1000,
    path: "/"
  };
}


router.get("/test",(req,res)=>{
    res.send("user test")
})
router.get('/register',(req,res)=>{
    res.render('register');


});
router.post(
  "/register",

  body("username").trim().isLength({ min: 3 }).withMessage("Username must be at least 3 characters long"),
  body("email").trim().isEmail().normalizeEmail().withMessage("Enter a valid email address"),
  body("password")
    .trim()
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters long")
    .matches(/[A-Z]/)
    .withMessage("Password must include at least one uppercase letter")
    .matches(/[a-z]/)
    .withMessage("Password must include at least one lowercase letter")
    .matches(/[0-9]/)
    .withMessage("Password must include at least one number"),
  body("confirm-password")
    .trim()
    .isLength({ min: 8 })
    .withMessage("Confirm password must be at least 8 characters long"),

  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          errors: errors.array(),
          message: "Invalid input data",
        });
      }

      const { username, email, password, role } = req.body;
      const confirmPassword = req.body['confirm-password'];

      if (password !== confirmPassword) {
        return res.status(400).json({
          message: "Passwords do not match",
        });
      }

      const existingUser = await User.findOne({
        $or: [{ email: email.toLowerCase() }, { username }]
      });

      if (existingUser) {
        return res.status(400).json({
          message: "User already exists",
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = new User({
        username,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: role || "viewer",
      });

      await newUser.save(); 

      await Activity.create({
        user: newUser._id,
        action: "Registered account",
        entityType: "User",
        entityName: newUser.username
      });

      if (req.headers['accept']?.includes('application/json')) {
        return res.json({ success: true, redirect: "/login" });
      }
      return res.redirect("/login");
    } catch (err) {
      console.log("SAVE ERROR:", err);
      if (req.headers['accept']?.includes('application/json')) {
        return res.status(500).json({ message: "Database error occurred" });
      }
      return res.status(500).send("Database error");
    }
  }
);


router.get('/login',(req,res)=>{
    res.render('login');
})
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      if (req.headers['accept']?.includes('application/json')) {
        return res.status(400).json({ message: "Email and password required" });
      }
      return res.status(400).send("Email and password required");
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      if (req.headers['accept']?.includes('application/json')) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      return res.status(401).send("Invalid credentials");
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      if (req.headers['accept']?.includes('application/json')) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      return res.status(401).send("Invalid credentials");
    }

    const token = jwt.sign(
      {
        userId: user._id.toString(),
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
    );

    res.cookie("token", token, {
      ...getCookieOptions()
    });

    if (req.headers['accept']?.includes('application/json')) {
      return res.json({ success: true, redirect: "/dashboard" });
    }
    res.redirect("/dashboard");
  } catch (err) {
    console.log("LOGIN ERROR:", err);
    if (req.headers['accept']?.includes('application/json')) {
      return res.status(500).json({ message: "Login failed" });
    }
    return res.status(500).send("Login failed");
  }
});

router.get("/logout", (req, res) => {
  res.clearCookie("token", getCookieOptions());
  return res.redirect("/");
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", getCookieOptions());

  if (req.headers['accept']?.includes('application/json')) {
    return res.json({ success: true });
  }

  return res.redirect("/");
});


module.exports=router;
