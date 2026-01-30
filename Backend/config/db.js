const mongoose = require('mongoose');
require('dotenv').config();

function connectDB() {
    mongoose.connect(process.env.MONGO_URI).then(()=>{
        console.log("Database connected successfully");
        console.log(" DB NAME:", mongoose.connection.name);

    })  
}
module.exports = connectDB;