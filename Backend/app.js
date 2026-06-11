require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const connectDB = require('./config/db');
const cookieParser = require("cookie-parser");
const path = require("path");

const userRouter = require("./routes/user.routes");
const adminRoutes = require("./routes/admin.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const documentRoutes = require("./routes/document.routes");
const activityRoutes = require("./routes/activity.routes");
const auth = require("./middlewares/auth.middleware");
const adminOnly = require("./middlewares/admin.middleware");

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/", userRouter);
app.get("/dashboard", auth, (req, res) => res.render("dashboard"));
app.get("/admin/pending-docs", auth, adminOnly, (req, res) => res.render("admin/pending-docs"));
app.use("/dashboard", dashboardRoutes);
app.use("/documents", documentRoutes);
app.use("/", activityRoutes);
app.use("/admin", adminRoutes);

app.get('/', (req, res) => {
  res.render('home');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
