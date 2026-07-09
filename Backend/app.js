require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const connectDB = require('./config/db');
const cookieParser = require("cookie-parser");
const path = require("path");
const helmet = require("helmet");

const userRouter = require("./routes/user.routes");
const adminRoutes = require("./routes/admin.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const documentRoutes = require("./routes/document.routes");
const activityRoutes = require("./routes/activity.routes");
const auth = require("./middlewares/auth.middleware");
const adminOnly = require("./middlewares/admin.middleware");

const app = express();
const isProduction = process.env.NODE_ENV === "production";

function validateConfig() {
  const required = ["MONGO_URI", "JWT_SECRET"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set("trust proxy", isProduction ? 1 : 0);

app.use(morgan('dev'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/", userRouter);
app.get("/dashboard", auth, (req, res) => res.render("dashboard"));
app.get("/admin/dashboard", auth, adminOnly, (req, res) => res.render("admin.dashboard"));
app.get("/admin/pending-docs", auth, adminOnly, (req, res) => res.render("admin/pending-docs"));
app.use("/dashboard", dashboardRoutes);
app.use("/documents", documentRoutes);
app.use("/", activityRoutes);
app.use("/admin", adminRoutes);

app.get('/', (req, res) => {
  res.render('home');
});

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use((err, req, res, next) => {
  if (err && err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ message: "Each file must be 10MB or smaller" });
    }

    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ message: "Unsupported file type or too many files uploaded" });
    }
  }

  console.error("UNHANDLED ERROR", err);
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  validateConfig();

  connectDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
      });
    })
    .catch((error) => {
      console.error("Failed to start server:", error.message);
      process.exit(1);
    });
}

module.exports = app;
