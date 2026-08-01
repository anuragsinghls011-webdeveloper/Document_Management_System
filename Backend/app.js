require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const connectDB = require('./config/db');
const cookieParser = require("cookie-parser");
const path = require("path");
const helmet = require("helmet");
const logger = require("./config/logger").createChildLogger("App");

const userRouter = require("./routes/user.routes");
const adminRoutes = require("./routes/admin.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const documentRoutes = require("./routes/document.routes");
const activityRoutes = require("./routes/activity.routes");
const documentsRoute = require('./routes/documents.routes');
const workflowsRoute = require('./routes/workflows.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const approvalsApiRoutes = require('./routes/approvals.routes');
const storageRoutes = require('./routes/storage.routes');
const workflowApiRoutes = require('./src/routes/workflowRoutes');
const auth = require("./middlewares/auth.middleware");
const adminOnly = require("./middlewares/admin.middleware");
const roleAuth = require("./middlewares/role.middleware");

const cors = require("cors");
const mongoSanitize = require("express-mongo-sanitize");
const rateLimit = require("express-rate-limit");

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

// Global Security Middleware
app.use(cors());
app.use(mongoSanitize());
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests from this IP, please try again later." }
});
app.use(globalLimiter);

// Structured HTTP logging via Winston instead of raw console output
app.use(morgan(isProduction ? 'combined' : 'dev', {
  stream: require("./config/logger").morganStream
}));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/assets", express.static(path.join(__dirname, "public")));

app.use("/", userRouter);
app.get("/dashboard", auth, (req, res) => res.render("dashboard"));
app.get("/admin/dashboard", auth, adminOnly, (req, res) => res.render("admin.dashboard"));
app.get("/admin/pending-docs", auth, adminOnly, (req, res) => res.render("admin/pending-docs"));
app.use("/dashboard", dashboardRoutes);
app.use("/api/documents", documentRoutes);
app.use("/documents", documentsRoute);
app.get("/analytics", auth, (req, res) => res.render("analytics"));
app.get("/settings", auth, (req, res) => res.render("setting", { user: req.user }));
app.get("/approvals", auth, roleAuth(["admin", "GM"]), (req, res) => res.render("approvals"));
app.use("/api/approvals", approvalsApiRoutes);
app.use("/api/workflow", workflowApiRoutes); // Workflow approval engine routes
app.use("/api/analytics", analyticsRoutes);
app.use("/", workflowsRoute); // workflows APIs and view
app.use("/", activityRoutes);
app.use("/api/settings", storageRoutes);
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

  logger.error("Unhandled error", { error: err.message, stack: err.stack, status: err.status });
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 3000;
const cluster = require('cluster');
const os = require('os');

if (require.main === module) {
  validateConfig();

  const numCPUs = os.availableParallelism ? os.availableParallelism() : os.cpus().length;

  if (isProduction && cluster.isPrimary) {
    logger.info(`Primary cluster process ${process.pid} is running`);
    logger.info(`Starting ${numCPUs} API workers to handle concurrent users...`);

    // Fork Express API workers
    for (let i = 0; i < numCPUs; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      logger.warn(`Worker ${worker.process.pid} died. Restarting to maintain capacity...`);
      cluster.fork();
    });

    // --- Background Services (Run ONLY in Primary Process) ---
    
    // Auto-fix stuck documents on startup
    const { reanalyzeStuckDocuments } = require("./controllers/document.controller");
    reanalyzeStuckDocuments().catch(err =>
      logger.error("Startup reanalyze failed", { error: err.message })
    );

    // Start BullMQ workflow workers if Redis is configured.
    if (process.env.REDIS_HOST) {
      try {
        const { startRoutingWorker } = require('./src/workers/routingWorker');
        const { startEscalationWorker } = require('./src/workers/escalationWorker');
        const { startEnrichmentWorker } = require('./src/workers/enrichmentWorker');
        startRoutingWorker();
        startEscalationWorker();
        startEnrichmentWorker();
        logger.info('Workflow engine workers started in primary process (routing + escalation + enrichment)');
      } catch (err) {
        logger.error('Failed to start workflow workers', { error: err.message });
      }
    } else {
      logger.info('REDIS_HOST not set — workflow engine workers not started (enrichment will run in-process on workers)');
    }

    // Start email watcher if configured
    if (process.env.EMAIL_PROVIDER) {
      const emailWatcher = require("./services/emailWatcher");
      emailWatcher.start().catch(err =>
        logger.error("Email watcher startup failed", { error: err.message })
      );

      const shutdown = async (signal) => {
        logger.info(`${signal} received — shutting down email watcher...`);
        try {
          await emailWatcher.stop();
        } catch (err) {
          logger.error("Email watcher shutdown error", { error: err.message });
        }
        process.exit(0);
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    }

  } else {
    // --- API Worker Process (or single-process dev mode) ---
    connectDB()
      .then(() => {
        app.listen(PORT, () => {
          logger.info(`API Server (Worker ${process.pid}) running on port ${PORT}`);
          
          // If in dev mode (no cluster), we need to start background services here
          if (!isProduction) {
            const { reanalyzeStuckDocuments } = require("./controllers/document.controller");
            reanalyzeStuckDocuments().catch(e => logger.error("Reanalyze failed", { error: e.message }));
            
            if (process.env.REDIS_HOST) {
              require('./src/workers/routingWorker').startRoutingWorker();
              require('./src/workers/escalationWorker').startEscalationWorker();
              require('./src/workers/enrichmentWorker').startEnrichmentWorker();
              logger.info('Workflow engine workers started in dev mode');
            }
            if (process.env.EMAIL_PROVIDER) {
              require("./services/emailWatcher").start().catch(e => logger.error("Email watcher failed", { error: e.message }));
            }
          }
        });
      })
      .catch((error) => {
        logger.error(`Worker ${process.pid} failed to start`, { error: error.message });
        process.exit(1);
      });
  }
}

module.exports = app;
