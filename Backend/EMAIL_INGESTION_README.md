# Email Ingestion Module

Automatically monitors an email inbox and ingests document attachments into the Document Management System pipeline — no manual upload required.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         Email Inbox                              │
│                  (Gmail / IMAP-compatible)                        │
└─────────────────────────┬────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                   emailWatcher.js (Factory)                       │
│          Reads EMAIL_PROVIDER env var, starts correct watcher     │
├────────────────────────┬─────────────────────────────────────────┤
│                        │                                         │
│  emailWatcher.imap.js  │  emailWatcher.gmail.js                  │
│  ─────────────────     │  ──────────────────                     │
│  • imapflow + mailparser│  • googleapis OAuth2                   │
│  • IDLE real-time push  │  • Polling (configurable interval)     │
│  • Exponential backoff  │  • History API incremental fetch       │
│  • Batch backlog sync   │  • Batch initial sync                  │
└────────────────────────┴──────────────┬──────────────────────────┘
                                        │
                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                emailIngestionService.js                           │
│  ────────────────────────────────────                            │
│  • Attachment validation (type, size)                            │
│  • Filename sanitization (path traversal prevention)             │
│  • Duplicate detection (ProcessedEmail collection)               │
│  • File saving to uploads/email/                                 │
│  • Document record creation                                      │
│  • AI enrichment queue integration                               │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              Existing Document Pipeline                           │
│  ────────────────────────────────────                            │
│  Document.create() → queueDocumentEnrichment()                   │
│  → OCR → AI Analysis → Classification → Routing → Approval      │
└──────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
cd Backend
npm install imapflow mailparser googleapis uuid
npm install --save-dev jest
```

### 2. Configure Environment

Copy `.env.example` to `.env` (if you haven't already) and fill in the email-related variables.

**For IMAP mode:**
```env
EMAIL_PROVIDER=imap
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your-inbox@gmail.com
IMAP_PASSWORD=your-app-password
```

**For Gmail API mode:**
```env
EMAIL_PROVIDER=gmail
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
```

### 3. Start the Server

```bash
npm run dev
```

The email watcher starts automatically when `EMAIL_PROVIDER` is set. If it's empty or unset, email ingestion is disabled entirely.

### 4. Run Tests

```bash
npx jest tests/emailIngestionService.test.js --verbose
```

---

## Setup Guide: IMAP with App Password

### Gmail

1. **Enable 2-Step Verification** on your Google account:
   - Go to [Google Account Security](https://myaccount.google.com/security)
   - Enable "2-Step Verification"

2. **Generate an App Password**:
   - Go to [App Passwords](https://myaccount.google.com/apppasswords)
   - Select "Mail" and your device
   - Copy the 16-character password

3. **Configure `.env`**:
   ```env
   EMAIL_PROVIDER=imap
   IMAP_HOST=imap.gmail.com
   IMAP_PORT=993
   IMAP_USER=your-email@gmail.com
   IMAP_PASSWORD=xxxx xxxx xxxx xxxx
   IMAP_TLS=true
   IMAP_FOLDER=INBOX
   ```

### Outlook / Microsoft 365

1. **Enable IMAP** in Outlook settings:
   - Settings → Mail → Sync email → IMAP: Yes

2. **Generate an App Password** (if using 2FA):
   - Go to [Security basics](https://account.live.com/proofs/manage/additional)
   - Select "App passwords"

3. **Configure `.env`**:
   ```env
   EMAIL_PROVIDER=imap
   IMAP_HOST=outlook.office365.com
   IMAP_PORT=993
   IMAP_USER=your-email@outlook.com
   IMAP_PASSWORD=your-app-password
   IMAP_TLS=true
   ```

### Generic IMAP Server

```env
EMAIL_PROVIDER=imap
IMAP_HOST=mail.your-domain.com
IMAP_PORT=993
IMAP_USER=inbox@your-domain.com
IMAP_PASSWORD=your-password
IMAP_TLS=true
IMAP_FOLDER=INBOX
```

---

## Setup Guide: Gmail API with OAuth2

### Step 1: Create GCP Project & Enable Gmail API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Navigate to **APIs & Services → Library**
4. Search for "Gmail API" and click **Enable**

### Step 2: Create OAuth2 Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Name: `DocuFlow Email Ingestion`
5. Authorized redirect URIs: Add `http://localhost:3000/auth/gmail/callback`
6. Click **Create** and note the **Client ID** and **Client Secret**

### Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. User type: **Internal** (for Workspace) or **External** (for personal Gmail)
3. Add the scope: `https://www.googleapis.com/auth/gmail.modify`
4. Add your email as a test user (if External)

### Step 4: Obtain a Refresh Token

Use the [Google OAuth2 Playground](https://developers.google.com/oauthplayground/):

1. Click the ⚙️ gear icon → Check "Use your own OAuth credentials"
2. Enter your Client ID and Client Secret
3. In Step 1, select `Gmail API v1 → https://www.googleapis.com/auth/gmail.modify`
4. Click **Authorize APIs** and sign in
5. In Step 2, click **Exchange authorization code for tokens**
6. Copy the **Refresh Token**

### Step 5: Configure `.env`

```env
EMAIL_PROVIDER=gmail
GMAIL_CLIENT_ID=123456789-abcdef.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-your-secret
GMAIL_REDIRECT_URI=http://localhost:3000/auth/gmail/callback
GMAIL_REFRESH_TOKEN=1//your-refresh-token
GMAIL_USER_EMAIL=me
```

---

## Switching Between Modes

Simply change the `EMAIL_PROVIDER` value in `.env`:

| Mode | Value | Use Case |
|------|-------|----------|
| IMAP | `imap` | Any IMAP-compatible inbox (Gmail, Outlook, custom) |
| Gmail API | `gmail` | Gmail/Workspace with OAuth2 |
| Disabled | _(empty/unset)_ | Email ingestion turned off |

No code changes needed. Just restart the server.

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_PROVIDER` | _(empty)_ | `imap`, `gmail`, or empty to disable |
| `IMAP_HOST` | `imap.gmail.com` | IMAP server hostname |
| `IMAP_PORT` | `993` | IMAP server port |
| `IMAP_USER` | — | IMAP login username/email |
| `IMAP_PASSWORD` | — | IMAP password or app password |
| `IMAP_TLS` | `true` | Use TLS/SSL |
| `IMAP_FOLDER` | `INBOX` | Mailbox folder to monitor |
| `GMAIL_CLIENT_ID` | — | OAuth2 Client ID |
| `GMAIL_CLIENT_SECRET` | — | OAuth2 Client Secret |
| `GMAIL_REDIRECT_URI` | `http://localhost:3000/auth/gmail/callback` | OAuth2 redirect URI |
| `GMAIL_REFRESH_TOKEN` | — | OAuth2 refresh token |
| `GMAIL_USER_EMAIL` | `me` | Gmail user to impersonate |
| `EMAIL_ALLOWED_TYPES` | `pdf,docx,doc,png,...` | Comma-separated allowed extensions |
| `EMAIL_MAX_ATTACHMENT_SIZE_MB` | `20` | Max attachment size in MB |
| `EMAIL_BATCH_SIZE` | `10` | Messages per batch on initial sync |
| `EMAIL_POLL_INTERVAL_MS` | `60000` | Gmail polling interval (ms) |
| `EMAIL_PROCESSED_TTL_DAYS` | `90` | Days to keep processed email records |
| `EMAIL_BOT_USERNAME` | `email-bot` | System bot user name |
| `EMAIL_BOT_EMAIL` | `email-bot@system.local` | System bot user email |

---

## How It Works

### Document Lifecycle (Email-Ingested)

```
Email Received → Attachment Extracted → Validation (type/size)
       ↓
  Dedup Check (ProcessedEmail collection)
       ↓
  File Saved to uploads/email/
       ↓
  Document Record Created (status: "processing")
       ↓
  AI Enrichment Queue (OCR → Gemini Analysis → Classification)
       ↓
  Document Routed to Department Manager (status: "pending")
       ↓
  Approval Workflow (same as manual uploads)
```

### Idempotency

The module prevents duplicate ingestion through two layers:

1. **Email-Level**: The `ProcessedEmail` collection tracks every processed message ID. Before processing, we check this collection. Safe across restarts.

2. **Mail Server-Level**: Processed emails are marked as `\Seen` (IMAP) or have `UNREAD` label removed (Gmail). This prevents re-fetching on the next poll/IDLE cycle.

### Reconnection (IMAP)

On connection failure, the IMAP watcher uses exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |
| ... | ... |
| Max | 5 min |

With ±20% random jitter to prevent thundering herd problems.

---

## Upgrading to Gmail Pub/Sub (Future)

The current Gmail implementation uses polling. For real-time notifications:

1. **Create a Pub/Sub topic** in GCP Console
2. **Grant publish permissions** to `gmail-api-push@system.gserviceaccount.com`
3. **Create a push subscription** pointing to your server's endpoint
4. **Call `users.watch()`** with your topic name
5. **Handle incoming notifications** at your push endpoint

This eliminates polling delay and reduces API quota usage.

---

## Troubleshooting

### IMAP: "Authentication failed"
- Verify your app password (not your regular password)
- For Gmail: Ensure 2-Step Verification is enabled
- Check `IMAP_USER` matches exactly

### IMAP: "Connection refused" or timeout
- Check `IMAP_HOST` and `IMAP_PORT`
- Verify firewall/network allows outbound connections on port 993
- Try `IMAP_TLS=false` with port 143 (for testing only)

### Gmail API: "invalid_grant"
- Refresh token may have expired — re-generate it
- Ensure the OAuth consent screen is not in "Testing" mode (limited token lifetime)
- Verify Client ID and Client Secret match

### Attachments not being ingested
- Check `EMAIL_ALLOWED_TYPES` includes the file extension
- Check `EMAIL_MAX_ATTACHMENT_SIZE_MB` is large enough
- Look for `[EmailIngestion]` log entries for skip reasons

### "No unseen messages found" but inbox has unread mail
- Verify `IMAP_FOLDER` matches the mailbox name (case-sensitive on some servers)
- Some IMAP servers use localized folder names (e.g., "Posteingang" in German)
