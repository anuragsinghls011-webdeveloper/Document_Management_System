const express = require('express');
const router = (express.Router());
const { body, validationResult } = require('express-validator');
const User = require('../models/user.model');
const bcrypt = require('bcrypt');
const jwt=require("jsonwebtoken");


router.get("/test",(req,res)=>{
    res.send("user test")
})
router.get('/register',(req,res)=>{
    res.render('register');


});
router.post(
  "/register",

  body("username").trim().notEmpty().withMessage("Username is required"),
  body("email").trim().isEmail().withMessage("Enter a valid email address"),
  body("password")
    .trim()
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters long"),
  body("confirm-password")
    .trim()
    .isLength({ min: 6 })
    .withMessage("Confirm password must be at least 6 characters long"),

  async (req, res) => {
    try {
      const errors = validationResult(req);

      console.log(errors.array()); 

      if (!errors.isEmpty()) {
        return res.status(400).json({
          errors: errors.array(),
          message: "Invalid input data",
        });
      }

      const { username, email, password } = req.body;
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
      });

      await newUser.save(); 

      return res.render("login");
    } catch (err) {
      console.log("SAVE ERROR:", err);
      return res.status(500).send("Database error");
    }
  }
);


router.get('/login',(req,res)=>{
    res.render('login');
})
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).send("Email and password required");
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).send("Invalid credentials");
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).send("Invalid credentials");
    }

    const token = jwt.sign(
      {
        userId: user._id.toString(),
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax"
    });

    res.redirect("/dashboard");
  } catch (err) {
    console.log("LOGIN ERROR:", err);
    return res.status(500).send("Login failed");
  }
});


module.exports=router;
