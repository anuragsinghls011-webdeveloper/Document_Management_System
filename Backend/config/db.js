const mongoose = require('mongoose');
require('dotenv').config();

function connectDB() {
    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI is not configured");
    }

    return mongoose
        .connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 10000,
            maxPoolSize: 10
        })
        .then(() => {
            console.log("Database connected successfully");
            console.log("DB NAME:", mongoose.connection.name);
        })
        .catch((error) => {
            console.error("Database connection failed:", error.message);
            throw error;
        });
}
module.exports = connectDB;
