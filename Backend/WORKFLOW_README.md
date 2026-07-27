# Workflow Engine — Automated Routing & Approval

This module provides an automated, data-driven document routing and multi-step approval engine with SLA-based escalation.

## Architecture Overview

```
Document Upload/Email → AI Extraction → Classification
                                             ↓
                                    ┌────────────────┐
                                    │  Routing Queue  │  (BullMQ)
                                    └───────┬────────┘
                                            ↓
                                  ┌──────────────────┐
                                  │  Routing Worker   │
                                  │  (Rules Engine)   │
                                  └───────┬──────────┘
                                          ↓
                               ┌─────────────────────┐
                               │  Approval Chain      │
                               │  Step 1 → Step 2 → …│
                               └─────────┬───────────┘
                                         ↓
                    ┌────────────────────────────────────────┐
                    │          For each step:                 │
                    │  • Assign approver                      │
                    │  • Notify via notifyQueue               │
                    │  • Schedule escalation (SLA timeout)    │
                    │  • Wait for POST /approve or /reject    │
                    └────────────────────────────────────────┘
                                         ↓
                    ┌─────────────┐  OR  ┌──────────────────┐
                    │  Approved    │      │  SLA Expired      │
                    │  (advance    │      │  (Escalation      │
                    │   or final)  │      │   Worker fires)   │
                    └─────────────┘      └──────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
cd Backend
npm install bullmq ioredis json-rules-engine
```

### 2. Configure Environment

Add to your `.env`:
```env
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
ESCALATION_SLA_MS=172800000  # 48 hours (use 60000 for 1-minute testing)
```

### 3. Start Redis

```bash
# macOS
brew install redis && redis-server

# Docker
docker run -d -p 6379:6379 redis:alpine

# Windows (via WSL or Docker)
```

### 4. Start the Server

```bash
npm run dev
```

Workers start automatically when `REDIS_HOST` is set.

---

## How to Add a New Routing Rule

Rules are defined in [`src/config/routingRules.js`](src/config/routingRules.js).

### Example: Route high-priority contracts to Legal → CEO

```js
{
  name: 'high-priority-contract',
  priority: 90,  // Higher than standard contract rule (80)
  conditions: {
    all: [
      {
        fact: 'documentType',
        operator: 'equal',
        value: 'Contract'
      },
      {
        fact: 'total_amount',
        operator: 'greaterThan',
        value: 100000
      }
    ]
  },
  event: {
    type: 'route',
    params: {
      ruleName: 'high-priority-contract',
      chain: ['hrManager', 'generalManager', 'admin']
    }
  }
}
```

### Steps:
1. Open `src/config/routingRules.js`
2. Add your rule object to the `rules` array
3. Set `priority` — higher number = higher precedence
4. Define `conditions` using [json-rules-engine syntax](https://github.com/CacheControl/json-rules-engine)
5. Set `event.params.chain` to an ordered list of roles (matching `User.role` values)
6. **No restart needed** if you use dynamic rule loading; otherwise restart the server

### Available Operators
| Operator | Description |
|----------|-------------|
| `equal` | Exact match |
| `notEqual` | Not equal |
| `greaterThan` | Numeric > |
| `greaterThanInclusive` | Numeric >= |
| `lessThan` | Numeric < |
| `lessThanInclusive` | Numeric <= |
| `in` | Value is in array |
| `notIn` | Value is not in array |
| `contains` | Array contains value |

### Available Facts
Facts are built from document fields. Add new defaults in `routingEngine.js > FACT_DEFAULTS`.

| Fact | Source | Default |
|------|--------|---------|
| `documentType` | `doc.documentType` or `extractedData.documentType` | `'Other'` |
| `department` | `doc.department` or `extractedData.department` | `'General'` |
| `total_amount` | `extractedData.total_amount` | `0` |
| `vendor_name` | `extractedData.vendor_name` | `''` |
| `sender_domain` | `extractedData.sender_domain` | `''` |
| `confidence` | `doc.confidence` | `0` |

---

## How to Change the SLA Escalation Window

### Option 1: Environment Variable (recommended)

```env
# In .env
ESCALATION_SLA_MS=3600000   # 1 hour
ESCALATION_SLA_MS=86400000  # 24 hours
ESCALATION_SLA_MS=172800000 # 48 hours (default)
```

Restart the server after changing.

### Option 2: Per-rule SLA (future)

The architecture supports per-rule SLA by adding a `slaMs` field to the rule event params. This is not yet implemented but the extension point exists in the routing worker.

---

## How to Swap the Approver Resolution Strategy

The default resolver does a simple `User.findOne({ role })` lookup.

### Example: Round-Robin Strategy

```js
const { setStrategy } = require('./src/services/approverResolver');
const User = require('./models/user.model');

const counters = {};

setStrategy(async (role) => {
  const users = await User.find({ role }).select('_id').lean();
  if (!users.length) return null;
  counters[role] = ((counters[role] || 0) + 1) % users.length;
  return users[counters[role]]._id.toString();
});
```

Call `setStrategy()` during app initialization (in `app.js` after DB connection).

---

## API Endpoints

### Approve a Document Step
```
POST /api/workflow/documents/:id/approve
Authorization: Cookie (JWT)
Body: { "note": "optional approval comment" }
```

**Responses:**
- `200` — Step approved (or document fully approved)
- `400` — Invalid ID or document not in pending_approval state
- `403` — You are not the current assigned approver
- `404` — Document not found
- `409` — Race condition: another request already processed this step

### Reject a Document
```
POST /api/workflow/documents/:id/reject
Authorization: Cookie (JWT)
Body: { "reason": "required rejection reason" }
```

**Responses:**
- `200` — Document rejected, chain stopped
- `400` — Missing reason or invalid state
- `403` — Not the current approver
- `409` — Race condition

### View Audit Trail
```
GET /api/workflow/documents/:id/history
Authorization: Cookie (JWT)
```

Returns the complete, immutable audit trail and current approval chain status.

---

## Triggering the Routing Queue

To route a document after classification, add a job to the routing queue:

```js
const { routingQueue } = require('./src/config/queue');

// After AI classification completes:
await routingQueue.add('route-document', {
  documentId: doc._id.toString(),
  routingVersion: (doc.routingVersion || 0) + 1
});
```

This is typically done in the `enrichDocument()` function in `document.controller.js` after AI analysis completes.

---

## Running Tests

```bash
cd Backend
npm install --save-dev supertest  # Required for route tests
npx jest src/__tests__/ --verbose
```

Tests cover:
- Rule precedence (highest-priority-wins)
- Missing-field fallback behavior
- Escalation chain advancement and exhaustion
- Stale-job detection (4 scenarios)
- Unauthorized approver rejection (403)
- Race condition handling (409)
- Deterministic routing (idempotency)
