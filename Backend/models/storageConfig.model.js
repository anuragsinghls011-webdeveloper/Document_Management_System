const mongoose = require("mongoose");

const storageConfigSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ["local", "gcs", "s3", "azure"],
      default: "local"
    },

    isActive: {
      type: Boolean,
      default: false
    },

    // ─── Google Cloud Storage ────────────────────────────────────────────────
    gcs: {
      projectId: { type: String, default: "" },
      bucketName: { type: String, default: "" },
      credentials: { type: String, default: "" } // Encrypted service account JSON
    },

    // ─── AWS S3 ──────────────────────────────────────────────────────────────
    s3: {
      region: { type: String, default: "" },
      bucketName: { type: String, default: "" },
      accessKeyId: { type: String, default: "" },     // Encrypted
      secretAccessKey: { type: String, default: "" }   // Encrypted
    },

    // ─── Azure Blob Storage ──────────────────────────────────────────────────
    azure: {
      accountName: { type: String, default: "" },
      containerName: { type: String, default: "" },
      accountKey: { type: String, default: "" }        // Encrypted
    },

    // ─── Connection Test Status ──────────────────────────────────────────────
    lastTestedAt: { type: Date },
    lastTestStatus: {
      type: String,
      enum: ["success", "failed", "untested"],
      default: "untested"
    },

    // ─── Migration Status ────────────────────────────────────────────────────
    migrationStatus: {
      type: String,
      enum: ["idle", "running", "completed", "failed"],
      default: "idle"
    },
    migrationProgress: {
      total: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      failed: { type: Number, default: 0 }
    },
    lastMigrationAt: { type: Date },

    // ─── Audit ───────────────────────────────────────────────────────────────
    configuredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    }
  },
  { timestamps: true }
);

// Singleton helper: always upsert a single document
storageConfigSchema.statics.getConfig = async function () {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({ provider: "local", isActive: false });
  }
  return config;
};

module.exports =
  mongoose.models.StorageConfig ||
  mongoose.model("StorageConfig", storageConfigSchema);
