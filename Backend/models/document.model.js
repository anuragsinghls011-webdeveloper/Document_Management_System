const mongoose = require("mongoose");

// ─── Approval Chain Step Sub-schema ──────────────────────────────────────────
// Each entry represents one step in the multi-step approval chain.
// Once created, entries should only be updated (status, actedAt) — never deleted.
const approvalChainStepSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "escalated", "skipped"],
      default: "pending"
    },
    actedAt: {
      type: Date
    }
  },
  { _id: false }
);

// ─── History Entry Sub-schema (Immutable Audit Trail) ────────────────────────
// COMPLIANCE REQUIREMENT: History entries must NEVER be overwritten or deleted.
// Each state transition appends a new entry. This is append-only by convention
// enforced at the application layer (no update/pull operations on this array).
const historyEntrySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      required: true
    },
    actor: {
      type: String, // userId string or 'system'
      required: true
    },
    note: {
      type: String,
      default: ""
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const documentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    fileName: {
      type: String,
      required: true
    },

    fileType: {
      type: String
    },

    fileHash: {
      type: String
    },

    filePath: {
      type: String,
      required: true
    },

    extractedText: {
      type: String,
      default: ""
    },

    summary: {
      type: String,
      default: ""
    },

    keywords: {
      type: [String],
      default: []
    },

    documentType: {
      type: String,
      default: ""
    },

    department: {
      type: String,
      default: ""
    },

    aiSummary: {
      type: String,
      default: ""
    },

    routedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },

    confidence: {
      type: Number,
      default: 0
    },

    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "review",
        "classified",        // AI classification done, awaiting routing
        "needs_review",      // Escalation chain exhausted or routing failed
        "pending_approval",  // In an active approval chain
        "approved",
        "rejected",
        "changes_requested",
        "archived"
      ],
      default: "pending"
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },

    approvedAt: {
      type: Date
    },

    rejectionReason: {
      type: String
    },

    reviewComment: {
      type: String
    },

    // ─── Workflow Engine Fields ────────────────────────────────────────────────

    /**
     * Structured data extracted by OCR/LLM step.
     * Rules engine evaluates conditions against this object.
     * Example: { total_amount: 15000, vendor_name: 'Acme Corp' }
     */
    extractedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },

    /**
     * The user who currently needs to take action (approve/reject).
     * Updated when the chain advances or escalation occurs.
     */
    currentApprover: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },

    /**
     * Ordered list of approval steps. Each step has a role, resolved userId,
     * and a status tracking whether that step is pending/complete.
     */
    approvalChain: {
      type: [approvalChainStepSchema],
      default: []
    },

    /**
     * Current position in the approval chain (0-indexed).
     * Incremented when an approver acts or escalation advances the chain.
     */
    approvalStep: {
      type: Number,
      default: 0
    },

    /**
     * Append-only audit trail. Every status change (routed, approved-step,
     * escalated, rejected, archived) appends an entry here.
     * NEVER overwrite or delete entries — required for compliance.
     */
    history: {
      type: [historyEntrySchema],
      default: []
    },

    /**
     * Idempotency guard for routing. Incremented each time routing runs.
     * A retried routing job checks this version — if it's already been
     * incremented, the job no-ops to avoid re-routing.
     */
    routingVersion: {
      type: Number,
      default: 0
    },

    /**
     * ID of the currently scheduled BullMQ escalation job.
     * Used by the escalation worker to detect stale jobs:
     * if doc.escalationJobId !== job.id, the job is stale and should no-op.
     */
    escalationJobId: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true
  }
);

documentSchema.index({
  fileName: "text",
  extractedText: "text",
  summary: "text",
  keywords: "text"
});

documentSchema.index({ userId: 1, createdAt: -1 });
documentSchema.index({ userId: 1, status: 1, createdAt: -1 });
documentSchema.index({ fileHash: 1 }, { sparse: true });
// Index for escalation worker queries: find docs pending approval for a specific approver
documentSchema.index({ status: 1, currentApprover: 1 });
documentSchema.index({ status: 1, 'approvalChain.userId': 1 });

module.exports = mongoose.model("Document", documentSchema);
