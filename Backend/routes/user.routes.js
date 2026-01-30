const express = require('express');
const router = (express.Router());
const { body, validationResult } = require('express-validator');
const { user: userModel } = require('../models/user.model');
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

      console.log("Register attempt for email:", email, "password:", password);

      const hashedPassword = await bcrypt.hash(password, 10);
      console.log("Hashed password:", hashedPassword);

      const newUser = new userModel({
        username,
        email: email.toLowerCase(),
        password: hashedPassword,
      });

      await newUser.save(); 
      console.log("USER SAVED:", newUser);

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
  const { email, password } = req.body;

  console.log("Login attempt for email:", email);
  console.log("Password provided:", password);

  const user = await userModel.findOne({ email: email.toLowerCase() });
  if (!user) {
    console.log("User not found for email:", email);
    return res.status(401).send("Invalid credentials");
  }

  console.log("User found:", user.email, "Hashed password:", user.password);

  const match = await bcrypt.compare(password, user.password);
  console.log("Password match result:", match);
  if (!match) {
    console.log("Password does not match");
    return res.status(401).send("Invalid credentials");
  }

  const token = jwt.sign(
  {
    userId: user._id.toString()   
  },
  process.env.JWT_SECRET,
  { expiresIn: "1d" }
);

res.cookie("token", token, {
  httpOnly: true
});


  
  res.redirect("/dashboard");
});


module.exports=router;
