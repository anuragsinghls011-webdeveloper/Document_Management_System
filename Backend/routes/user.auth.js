
const authMiddleware = (req, res, next) => {
  const token = req.header("Authorization");

  
  if (!token) {
    return res.status(401).json({ message: "Access denied. No token provided." });
  }

  try {
    
    const actualToken = token.startsWith("Bearer ") ? token.slice(7) : token;

    
    const decoded = jwt.verify(actualToken, "YOUR_SECRET_KEY");

    
    req.user = decoded;

    next(); 
  } catch (err) {
    res.status(400).json({ message: "Invalid Token" });
  }
};

module.exports = authMiddleware;
const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const userModel = require('../models/user.model');