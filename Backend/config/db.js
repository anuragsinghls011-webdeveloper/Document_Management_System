const mongoose = require('mongoose');
require('dotenv').config();

function connectDB() {
    if (!process.env.MONGO_URI) {
        console.error("MONGO_URI is not configured");
        return Promise.resolve();
    }

    return mongoose.connect(process.env.MONGO_URI).then(()=>{
        console.log("Database connected successfully");
        console.log(" DB NAME:", mongoose.connection.name);

    }).catch((error) => {
        console.error("Database connection failed:", error.message);
    });
}
module.exports = connectDB;
