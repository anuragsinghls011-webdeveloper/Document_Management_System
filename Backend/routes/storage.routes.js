const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const adminOnly = require("../middlewares/admin.middleware");
const StorageConfig = require("../models/storageConfig.model");
const { encrypt, decrypt, testConnection, migrateExistingDocuments } = require("../services/storageService");
const logger = require("../config/logger").createChildLogger("StorageRoutes");

// All routes require auth + admin
router.use(auth, adminOnly);

// ─── GET /api/settings/storage — Get current storage config ─────────────────
router.get("/storage", async (req, res) => {
  try {
    const config = await StorageConfig.getConfig();

    // Mask sensitive credentials before sending to client
    const safe = {
      provider: config.provider,
      isActive: config.isActive,
      lastTestedAt: config.lastTestedAt,
      lastTestStatus: config.lastTestStatus,
      migrationStatus: config.migrationStatus,
      migrationProgress: config.migrationProgress,
      lastMigrationAt: config.lastMigrationAt,
      gcs: {
        projectId: config.gcs?.projectId || "",
        bucketName: config.gcs?.bucketName || "",
        hasCredentials: !!(config.gcs?.credentials)
      },
      s3: {
        region: config.s3?.region || "",
        bucketName: config.s3?.bucketName || "",
        hasAccessKey: !!(config.s3?.accessKeyId),
        hasSecretKey: !!(config.s3?.secretAccessKey)
      },
      azure: {
        accountName: config.azure?.accountName || "",
        containerName: config.azure?.containerName || "",
        hasAccountKey: !!(config.azure?.accountKey)
      }
    };

    res.json({ success: true, config: safe });
  } catch (err) {
    logger.error("Get storage config error", { error: err.message });
    res.status(500).json({ success: false, message: "Failed to fetch storage config" });
  }
});

// ─── PUT /api/settings/storage — Save / update storage config ───────────────
router.put("/storage", async (req, res) => {
  try {
    const { provider, gcs, s3, azure } = req.body;

    if (!["local", "gcs", "s3", "azure"].includes(provider)) {
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }

    const config = await StorageConfig.getConfig();
    config.provider = provider;
    config.isActive = provider !== "local";
    config.configuredBy = req.user.id;

    // Update provider-specific fields
    if (provider === "gcs" && gcs) {
      config.gcs.projectId = gcs.projectId || "";
      config.gcs.bucketName = gcs.bucketName || "";
      if (gcs.credentials) {
        config.gcs.credentials = encrypt(gcs.credentials);
      }
    }

    if (provider === "s3" && s3) {
      config.s3.region = s3.region || "";
      config.s3.bucketName = s3.bucketName || "";
      if (s3.accessKeyId) {
        config.s3.accessKeyId = encrypt(s3.accessKeyId);
      }
      if (s3.secretAccessKey) {
        config.s3.secretAccessKey = encrypt(s3.secretAccessKey);
      }
    }

    if (provider === "azure" && azure) {
      config.azure.accountName = azure.accountName || "";
      config.azure.containerName = azure.containerName || "";
      if (azure.accountKey) {
        config.azure.accountKey = encrypt(azure.accountKey);
      }
    }

    await config.save();

    logger.info("Storage config updated", {
      provider,
      adminId: req.user.id
    });

    res.json({ success: true, message: `Storage provider set to ${provider}` });
  } catch (err) {
    logger.error("Save storage config error", { error: err.message });
    res.status(500).json({ success: false, message: "Failed to save storage config" });
  }
});

// ─── POST /api/settings/storage/test — Test connection ──────────────────────
router.post("/storage/test", async (req, res) => {
  try {
    const { provider, credentials } = req.body;

    if (!provider || !credentials) {
      return res.status(400).json({ success: false, message: "Provider and credentials required" });
    }

    const result = await testConnection(provider, credentials);

    // Update test status in config
    const config = await StorageConfig.getConfig();
    config.lastTestedAt = new Date();
    config.lastTestStatus = "success";
    await config.save();

    res.json({ success: true, message: result.message });
  } catch (err) {
    // Update test status as failed
    try {
      const config = await StorageConfig.getConfig();
      config.lastTestedAt = new Date();
      config.lastTestStatus = "failed";
      await config.save();
    } catch (updateErr) {
      logger.error("Failed to update test status", { error: updateErr.message });
    }

    logger.error("Storage connection test failed", { error: err.message });
    res.status(400).json({
      success: false,
      message: `Connection failed: ${err.message}`
    });
  }
});

// ─── POST /api/settings/storage/migrate — Migrate existing docs to cloud ────
router.post("/storage/migrate", async (req, res) => {
  try {
    // Start migration asynchronously
    res.json({
      success: true,
      message: "Migration started. Check progress in the settings page."
    });

    // Run migration in background (don't await in the response)
    migrateExistingDocuments().catch(err => {
      logger.error("Migration failed", { error: err.message });
    });
  } catch (err) {
    logger.error("Migration start error", { error: err.message });
    res.status(500).json({ success: false, message: "Failed to start migration" });
  }
});

// ─── GET /api/settings/storage/migration-status — Check migration progress ──
router.get("/storage/migration-status", async (req, res) => {
  try {
    const config = await StorageConfig.getConfig();
    res.json({
      success: true,
      status: config.migrationStatus,
      progress: config.migrationProgress,
      lastMigrationAt: config.lastMigrationAt
    });
  } catch (err) {
    logger.error("Migration status error", { error: err.message });
    res.status(500).json({ success: false, message: "Failed to fetch migration status" });
  }
});

// ─── DELETE /api/settings/storage — Reset to local storage ──────────────────
router.delete("/storage", async (req, res) => {
  try {
    const config = await StorageConfig.getConfig();
    config.provider = "local";
    config.isActive = false;
    config.lastTestStatus = "untested";
    config.lastTestedAt = null;
    config.gcs = { projectId: "", bucketName: "", credentials: "" };
    config.s3 = { region: "", bucketName: "", accessKeyId: "", secretAccessKey: "" };
    config.azure = { accountName: "", containerName: "", accountKey: "" };
    config.configuredBy = req.user.id;
    await config.save();

    logger.info("Storage config reset to local", { adminId: req.user.id });

    res.json({ success: true, message: "Storage reset to local disk" });
  } catch (err) {
    logger.error("Reset storage config error", { error: err.message });
    res.status(500).json({ success: false, message: "Failed to reset storage config" });
  }
});

module.exports = router;
