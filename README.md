# Document Management System (Node.js + Express + MongoDB)

A document management web app built with **Node.js**, **Express**, **MongoDB (Mongoose)**, and **EJS** views. It supports user authentication (JWT in an httpOnly cookie), document uploads (stored on disk), document listing/search/stats, and an admin approval workflow.

> This repository currently contains a single application in `Backend/` (there is no separate frontend build step).

## Features

- **Auth**: Register + login, JWT stored in an **httpOnly** cookie (`token`)
- **Document upload**: Multi-file upload via `multer` (up to **100 files**, **10MB** each)
- **My documents**: List your uploaded documents with timestamps and status
- **Search & filters**: Search by filename + filter by status, type, and date
- **Stats**: Per-user document stats (total / today / pending / archived + monthly counts)
- **Admin approvals**: Admins can view pending docs and **approve / reject / request changes**
- **Activity feed**: Recent audit-like activity entries (latest 5)

## Tech Stack

- **Backend**: Node.js, Express, EJS
- **Database**: MongoDB, Mongoose
- **Auth**: JSON Web Tokens (`jsonwebtoken`), cookies (`cookie-parser`)
- **Uploads**: Multer
- **Logging**: Morgan
- **Validation**: express-validator

Optional / included but not wired everywhere:

- `tesseract.js` + `Backend/services/ocr.service.js` (OCR helper)
- `Backend/services/ai.service.js` (basic keyword + summary helpers)
- `pdf-parse` dependency (not currently used in controllers)

## Project Structure

```
Document_Management_System/
  Backend/
    app.js
    package.json
    config/
      db.js
    controllers/
    middlewares/
    models/
    routes/
    services/
    uploads/              # created at runtime (ignored by git)
    views/                # EJS templates
```

## Getting Started

### Prerequisites

- Node.js (18+ recommended)
- MongoDB (local or Atlas)

### 1) Install dependencies

From the repository root:

```bash
cd Backend
npm install
```

### 2) Configure environment variables

Create `Backend/.env`:

```env
MONGO_URI=mongodb://127.0.0.1:27017/document_management
PORT=3000
JWT_SECRET=replace_me_with_a_strong_secret
JWT_EXPIRES_IN=1d
JWT_COOKIE_EXPIRES_IN=1
```

Notes:

- `MONGO_URI` is required to connect MongoDB.
- `PORT` defaults to `3000` if not set.
- `JWT_EXPIRES_IN` and `JWT_COOKIE_EXPIRES_IN` are present in `.env` but the current login flow in `Backend/routes/user.routes.js` uses a hardcoded JWT expiry of `1d`.

### 3) Run the app

Development (with reload):

```bash
cd Backend
npm run dev
```

Production:

```bash
cd Backend
npm start
```

Open:

- Home: `http://localhost:3000/`
- Register: `http://localhost:3000/register`
- Login: `http://localhost:3000/login`
- Dashboard (requires login): `http://localhost:3000/dashboard`

## Usage Guide

### Register & login

1. Visit `/register` and create an account.
2. Visit `/login` and sign in.
3. On success, the server sets an httpOnly cookie named `token` and redirects to `/dashboard`.

### Upload documents

On `/dashboard`, use the Upload flow. Files are stored in `Backend/uploads/` and are served at:

- `/uploads/<stored-filename>`

The `Document` record stores the relative file path as:

- `uploads/<stored-filename>`

### Admin approvals

Admin-only UI route:

- `GET /admin/pending-docs` (renders `Backend/views/admin.dashboard.ejs`)

To make a user an admin, update their `role` field in MongoDB:

```js
// Example (Mongo Shell / mongosh):
db.users.updateOne({ email: "admin@example.com" }, { $set: { role: "admin" } })
```

## Routes / API

All endpoints below assume the server runs at `http://localhost:3000`.

### Pages (EJS)

- `GET /` → `home.ejs`
- `GET /register` → `register.ejs`
- `GET /login` → `login.ejs`
- `GET /dashboard` (auth) → `dashboard.ejs`
- `GET /admin/pending-docs` (auth + admin) → `admin.dashboard.ejs`

### Auth behavior

- Authenticated requests rely on the `token` cookie.
- Protected routes use `Backend/middlewares/auth.middleware.js`.
- Admin-only routes additionally use `Backend/middlewares/admin.middleware.js` (requires `role === "admin"` in the JWT).

### Document routes (`/documents`)

- `POST /documents/upload` (auth)
  - `multipart/form-data`
  - field: `documents` (array), up to 100 files
- `GET /documents/my` (auth) → your documents
- `GET /documents/stats` (auth) → `{ total, today, pending, archived, monthly[] }`
- `GET /documents/search` (auth)
  - query params:
    - `q`: filename search (case-insensitive)
    - `status`: `pending|processing|review|approved|rejected|changes_requested|archived` (also accepts aliases like `in review`)
    - `type`: file extension (e.g. `pdf`, `png`), or `all`
    - `date`: `YYYY-MM-DD`
- `GET /documents/recent` (auth) → latest 5 (simplified payload)

### Admin routes (`/admin`) (admin-only)

- `GET /admin/pending` → pending documents
- `POST /admin/approve/:id` → mark approved
- `POST /admin/reject/:id` → mark rejected (accepts JSON body `{ reason/comment }`)
- `POST /admin/request-changes/:id` → mark `changes_requested` (requires JSON body `{ comment }`)

### Activity routes

- `GET /activities/recent` (auth) → last 5 activities (populated with `user.username`)

### Dashboard routes (`/dashboard`)

- `GET /dashboard/stats` (auth) → `{ totalDocuments, approvedDocuments, pendingDocuments }`

## Data Models (MongoDB)

### `User` (`Backend/models/user.model.js`)

- `username` (unique)
- `email` (unique)
- `password` (bcrypt hash)
- `role`: `user` or `admin` (default `user`)

### `Document` (`Backend/models/document.model.js`)

- `userId` (ref `User`)
- `fileName`, `fileType`, `filePath`
- `status`: `pending | processing | review | approved | rejected | changes_requested | archived`
- Optional workflow fields: `approvedBy`, `approvedAt`, `rejectionReason`, `reviewComment`
- AI-ready fields: `extractedText`, `summary`, `keywords` (stored but not populated by current upload controller)

### `Activity` (`Backend/models/activity.model.js`)

- `user` (ref `User`)
- `action`, `entityType`, `entityName`, optional `comment`

## Scripts

From `Backend/`:

- `npm run dev` → start with `nodemon`
- `npm start` → start with `node app.js`
- `npm test` → `node --check app.js` (syntax check)

## Notes & Limitations

- **File validation**: Upload currently does not restrict file types beyond size limits.
- **OCR / summaries**: Helper services exist in `Backend/services/`, but the upload controller currently stores basic metadata only.
- **CDN dependencies**: `dashboard.ejs` pulls Tailwind/Chart.js/Feather Icons from CDNs, so the UI needs internet access unless you vendor these assets.

## Implementation Notes (WIP / not currently wired)

- `GET /admin/pending-docs` renders `Backend/views/admin.dashboard.ejs`. A more elaborate template exists at `Backend/views/admin/pending-docs.ejs`, but it is not currently rendered by `Backend/app.js`.
- `Backend/routes/auth.routes.js` + `Backend/controllers/auth.controller.js` provide JSON-style auth endpoints, but `Backend/app.js` mounts `Backend/routes/user.routes.js` instead.
- `Backend/routes/user.auth.js` includes Bearer-token support, but protected routes use `Backend/middlewares/auth.middleware.js` (cookie-based).
- `cors` is installed but not configured in `Backend/app.js`.

## Troubleshooting

- **MongoDB not connecting**: Ensure `MONGO_URI` is set in `Backend/.env` and MongoDB is reachable.
- **Getting `No token` on protected routes**: Login via `/login` so the `token` cookie is set; browser requests must include cookies.
- **Uploads not accessible**: Uploaded files are served under `/uploads` and stored under `Backend/uploads/`.

## Contributing

PRs are welcome. Please keep changes focused and run `npm test` from `Backend/` before submitting.

## License

This project is currently unlicensed (no `LICENSE` file found). Add a license if you plan to distribute it.
