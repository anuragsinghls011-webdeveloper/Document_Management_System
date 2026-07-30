const mongoose = require('mongoose');
require('dotenv').config();
const logger = require('./logger').createChildLogger('Database');

function connectDB() {
    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI is not configured");
    }

    return mongoose
        .connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 10000,
            maxPoolSize: 50 // Increased for high concurrency
        })
        .then(() => {
            logger.info("Database connected successfully");
            logger.info(`DB NAME: ${mongoose.connection.name}`);
        })
        .catch((error) => {
            logger.error("Database connection failed", { error: error.message });
            throw error;
        });
}
module.exports = connectDB;
