require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const connectDB = require('./config/db');
const cookieParser = require("cookie-parser");
const path = require("path");

const userRouter = require("./routes/user.routes");
const adminRoutes = require("./routes/admin.routes");


connectDB();

const app = express();

app.set('view engine', 'ejs');

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));


app.use("/", userRouter);
app.get("/dashboard", require("./middlewares/auth.middleware"), (req, res) => res.render("dashboard"));
app.use("/dashboard", require("./routes/dashboard.routes"));
app.use("/documents", require("./routes/document.routes"));

const activityRoutes = require("./routes/activity.routes");

app.use("/", activityRoutes);
app.use("/admin", adminRoutes);



app.get('/', (req, res) => {
  res.render('home');
});
app.get('/register', (req, res) => {
  res.render('register');
})
app.get('/login', (req, res) => {
  res.render('login');
})
app.get('/dashboard', (req, res) => {
  res.render('dashboard');
});
app.get('/admin/pending-docs',(req,res) =>{
  res.render('admin/pending-docs');

});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
