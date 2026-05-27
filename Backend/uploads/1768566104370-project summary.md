*1 — Project Summary (one-liner)*



*Build a secure, scalable AI-powered Intelligent Document Management System (IDMS) for KMRL that ingests multi-format documents, runs an asynchronous AI processing pipeline (OCR → NER → summarization → categorization → embeddings), supports hybrid keyword+semantic search, enforces RBAC workflows and an immutable audit trail — implemented with Flask, MySQL, Celery+Redis, Elasticsearch, Tesseract, HuggingFace/Sentence-Transformers, and a HTML/CSS/JS frontend — deployable via Docker Compose.*



*2 — Tech Stack (final)*



*Frontend: HTML, CSS, JavaScript (vanilla) + TailwindCSS + Recharts for charts + optional Shadcn-like component styles (adapted to plain HTML/CSS).*



*Backend API: Flask (blueprints; Flask-RESTful / Flask-JWT-Extended)*



*Async worker: Celery (Redis broker; optional Redis backend or results stored in DB)*



*Database: MySQL (metadata, users, roles, workflows, audit\_logs, documents)*



*Search: Elasticsearch (keyword BM25 + dense\_vector for embeddings)*



*AI/NLP: HuggingFace Transformers (T5/BART for summarization, HF NER or fine-tuned transformers for extraction), sentence-transformers for embeddings*



*OCR: Tesseract with English + Malayalam language packs*



*File storage: Local ./uploads (S3-compatible storage optional for prod)*



*Containerization: Docker + docker-compose*



*Observability: Prometheus + Grafana (optional), ELK/Fluentd for logs*



*CI/CD: GitHub Actions (build/test/deploy)*



*Security: HTTPS (Let’s Encrypt), JWT signing + refresh tokens, role-based decorators, audit logs, secrets in environment variables / vault*



*3 — High-Level Architecture \& Data Flow*



*User uploads file via browser UI (HTML form / JS fetch).*



*Browser POSTs file to POST /api/v1/documents/upload with JWT.*



*Flask stores file (./uploads) and creates a documents row in MySQL with status = 'pending'.*



*Flask enqueues a Celery task tasks.process\_document(document\_id, filepath, uploader\_id) using Redis broker.*



*Celery worker executes pipeline asynchronously:*



*(a) File type detection*



*(b) OCR (scanned images/PDFs using Tesseract with Malayalam+English)*



*(c) Text extraction for docx, eml (python-docx, email module)*



*(d) NER extraction (HF model) → entities JSON*



*(e) Summarization (short action-oriented + detailed)*



*(f) Zero-shot classifier or fine-tuned classifier → category*



*(g) Embedding generation (sentence-transformers) → vector*



*(h) Update MySQL documents row (status='processed', extracted\_text, summary, entities JSON, category)*



*(i) Index document in Elasticsearch (raw\_text, metadata, vector)*



*(j) Apply routing rules → update workflow assignment + status (e.g., pending\_approval\_finance) and write audit logs.*



*Users query via search UI; Flask GET /api/v1/documents/search?q=... issues hybrid ES query (BM25 + kNN).*



*Workflow actions (approve/reject) handled via POST /api/v1/workflow/approve/{id} etc.; audit log written for every action.*



*4 — API Endpoints (contractual \& examples)*



*All APIs under /api/v1*



*Auth*



*POST /api/v1/auth/login*



*Request: { "email": "...", "password": "..." }*



*Response: { "access\_token": "...", "refresh\_token": "...", "user": {id, name, email, role} }*



*Notes: Use bcrypt for password hashing; JWT payload contains sub, email, role, exp, iat.*



*POST /api/v1/auth/refresh*



*Request: { "refresh\_token": "..." } → returns new access token.*



*Documents*



*POST /api/v1/documents/upload*



*Auth: Bearer.*



*Request: multipart/form-data file + optional metadata {department, docket\_no}.*



*Response: { "document\_id": 123, "status": "pending" }*



*Server actions: save file, insert MySQL record, enqueue Celery task, insert audit log.*



*GET /api/v1/documents/{id}*



*Auth: role check to view.*



*Response: {id, filename, uploaded\_by, status, summary\_short, summary\_long, entities, category, created\_at}*



*GET /api/v1/documents/search?q=...\&k=10*



*Auth: required.*



*Query params: q, k (limit), filter\_category, date\_from, date\_to.*



*Response: Ordered list with score, snippet, metadata.*



*Workflow*



*GET /api/v1/workflow/my*



*Returns docs assigned to user's role.*



*POST /api/v1/workflow/approve/{document\_id}*



*Body: { comments: "...", next\_action: "release" }*



*Response: updated status. Writes audit log.*



*POST /api/v1/workflow/reject/{document\_id}*



*Analytics*



*GET /api/v1/analytics/summary*



*Response: { by\_category: \[{category, count}], by\_status: \[{status, count}], circulars\_over\_time: \[{date, count}] }*



*Audit*



*GET /api/v1/audit?document\_id=\&user=\&from=\&to= (admins only)*



*5 — MySQL Schema (core tables)*



*(Use InnoDB; utf8mb4; timestamps in UTC)*



*users*



*id INT PK AUTO\_INCREMENT*



*email VARCHAR(255) UNIQUE NOT NULL*



*name VARCHAR(200)*



*password\_hash VARCHAR(255)*



*role ENUM('Admin','Director','Finance Officer','Station Controller','Clerk','Viewer',...) NOT NULL*



*is\_active TINYINT(1)*



*created\_at, updated\_at*



*documents*



*id INT PK AUTO\_INCREMENT*



*filename VARCHAR(512)*



*filepath VARCHAR(1024)`*



*uploaded\_by INT FK users(id)*



*department VARCHAR(128)*



*status ENUM('pending','processing','processed','pending\_approval\_finance','approved','rejected') DEFAULT 'pending'*



*category VARCHAR(64) NULL*



*summary\_short TEXT*



*summary\_long MEDIUMTEXT*



*extracted\_text LONGTEXT*



*entities\_json JSON*



*embedding\_id VARCHAR(64) NULL (optional cross-ref)*



*created\_at DATETIME, updated\_at DATETIME*



*audit\_logs*



*id BIGINT PK*



*timestamp DATETIME*



*user\_email VARCHAR(255)*



*action\_type VARCHAR(64) -- e.g., 'upload','view','search','approve','reject','summary\_generated'*



*document\_id INT NULL*



*metadata JSON*



*(Immutable: never update a row; only insert new rows)*



*workflows*



*id, document\_id FK, assigned\_role, assigned\_to\_user\_id, status, created\_at, updated\_at, history JSON*



*roles\_permissions` (optional RBAC)*



*role, permissions JSON*



*Add appropriate indexes: documents(category), documents(status), documents(created\_at), FULLTEXT index on extracted\_text (if useful), and ensure character sets support Malayalam.*



*6 — Celery Task Pipeline (detailed)*



*Task name: tasks.process\_document(document\_id)*



*Steps (each step updates progress and writes to audit logs on success/failure):*



*File type detection — use python-magic / file extension safe-check.*



*Text extraction*



*.pdf → if vector PDF (text layer), use pdfminer.six or PyMuPDF for text extraction.*



*scanned .pdf or images → Tesseract OCR (pytesseract) with --oem 1 + Malayalam (mal) + eng packs.*



*.docx → python-docx*



*.eml → Python email module, extract text and attachments*



*.jpg/.png → Tesseract*



*Text cleaning \& language detection — langdetect or fasttext to choose extra processing (Malayalam vs English).*



*NER Extraction — use an HF model (fine-tune if needed) or spaCy with transformer pipeline. Extract structured fields: vendor, invoice id, amounts, employee ids, dates, deadlines.*



*Summarization — run two passes:*



*Short action-oriented summary (max ~30–60 tokens)*



*Detailed summary (200–500 tokens)*

*Use T5-base or BART-large; if using GPU, batch with FP16.*



*Zero-shot Category — use HF pipeline zero-shot-classification (candidate labels: Finance, Legal, Safety, HR, Maintenance, Compliance).*



*Embeddings — sentence-transformers (all-mpnet-base-v2 or multilingual model that supports Malayalam like sentence-transformers/paraphrase-xlm-r-multilingual-v1), produce 768-d vector.*



*Elasticsearch Index — index document metadata + raw text + dense\_vector field for embeddings (map with dense\_vector).*



*Routing Rules — simple rules engine (YAML or DB-driven): e.g., if category == Finance and contains "Invoice" -> assign role Finance Officer.*



*DB Update — update MySQL row: extracted\_text, summary\_short, summary\_long, entities\_json, category, status='processed' or next status.*



*Audit — for each major step write to audit\_logs.*



*Failure Handling — on exception, set status='processing\_failed', send notification and write audit log.*



*Notes: Chunk long documents for summarization and embedding (sliding window + aggregate embeddings / chunk-level retrieval + re-ranking).*



*7 — Search — Hybrid Query Design (Elasticsearch)*



*Index mapping:*



*text field: text with english analyzer; also an ngram subfield for fuzzy.*



*metadata fields: category, filename, uploader, dates (keyword).*



*embedding field: dense\_vector (use appropriate ES version supporting KNN).*



*Hybrid Query Flow:*



*Convert user query to embedding using same sentence-transformer model.*



*Create ES query that combines:*



*BM25 multi\_match on filename, text, entities\_json (boost exact terms or invoice id).*



*knn or script\_score using cosine similarity on embedding (scale to 0-1).*



*Weighted scoring: e.g., score = 0.6\*bm25 + 0.4\*semantic (tune weights).*



*Post-process: re-rank by recency, department, or exact id matches.*



*API: GET /api/v1/documents/search?q=...\&category=...\&k=25*



*Frontend: show snippet, highlights, category tags, confidence score.*



*8 — Auth \& RBAC (Flask adaptation)*



*Use Flask-JWT-Extended for JWT handling (access \& refresh tokens).*



*JWT claims: { "sub": user\_id, "email": user\_email, "role": role, "iat":..., "exp": ... }*



*Store refresh tokens in DB for revocation.*



*Implement decorator @role\_required(\['Finance Officer','Director']) to guard endpoints.*



*Frontend stores access\_token in localStorage and refresh\_token in httpOnly secure cookie (recommended). JS attaches Authorization: Bearer <access\_token> header.*



*Rate-limit sensitive endpoints (Flask-Limiter).*



*Ensure CSRF protection on state-changing endpoints (or use only bearer tokens with CORS configured).*



*9 — Frontend (HTML/CSS/JS) Guidance*



*Use a single-page-app-like structure using vanilla JS and history API or lightweight router.*



*Components:*



*Login page (store tokens)*



*Upload page with drag-and-drop + progress bar (use XHR/fetch with progress)*



*Search bar (global top), search results with highlights and filters*



*Document viewer page (summary, entities, full text, download)*



*My Workflow page (approve/reject)*



*Analytics dashboard page using Recharts (charts via Chart.js can be used too if easier)*



*Security: input sanitization, escape rendered HTML, disallow inline scripts, set Content Security Policy.*



*10 — Docker Compose (services)*



*docker-compose.yml should include:*



*flask-api (build from Dockerfile; expose 5000)*



*frontend (optional nginx static server serving built html/css/js)*



*mysql (image: mysql:8, with volumes)*



*redis (for Celery broker)*



*celery-worker (same image as flask but runs celery -A app.celery worker)*



*celery-beat (optional scheduler)*



*elasticsearch (version compatible with dense\_vector; ensure memory limits)*



*tesseract — include tesseract in the worker image (apt install + language packs)*



*(optional) flower, nginx, traefik for SSL, minio for S3-like storage*



*Provide healthchecks, volumes, environment variables via .env, and init scripts to create DB schema and admin user.*



*11 — Security \& Compliance Notes*



*Use HTTPS (TLS). Terminate TLS at reverse proxy (nginx/traefik).*



*JWT signing using strong secret (rotate keys periodically).*



*Secrets in environment or secrets manager. Do not commit secrets.*



*Database credentials: least-privileged user.*



*Audit logs: insert-only (append), do not allow edit/delete.*



*Role-based access enforcement server-side; never rely on frontend for access control.*



*Sanitize file uploads: limit file size, validate mime-types, scan for malware (ClamAV optional).*



*Data retention \& encryption: at rest encryption for MySQL and backups; Elasticsearch encryption in transit.*



*GDPR-like considerations for PII: redact or limit display where necessary.*



*12 — Observability, Monitoring \& Backups*



*Logging: Structured JSON logs (include request id, user id, trace id). Ship logs to ELK or similar.*



*Tracing: integrate OpenTelemetry for request traces across Flask \& Celery.*



*Metrics: export Prometheus metrics from Flask and Celery; dashboards in Grafana.*



*Backups: mysqldump scheduled backups to object storage; periodic Elasticsearch snapshot.*



*Alerts: set alerts for Celery failures, queue backlog, low disk, high error rate.*



*13 — Testing \& QA*



*Unit tests: pytest for Flask endpoints and Celery tasks (use SQLite/MySQL test instance).*



*Integration tests: run docker-compose with test data and run end-to-end flows (upload → processed → search).*



*Load testing: use k6 or Locust to simulate concurrent uploads \& search queries.*



*Security testing: run static scan (bandit), dependency checks (safety), container scanning.*



*14 — Performance \& Scalability Considerations*



*Horizontal scale Celery workers and Flask via gunicorn + gevent (or uvicorn with ASGI variant like Quart if you want async).*



*Indexing: bulk index during processing to reduce ES calls.*



*Use an S3 object store for files in prod and avoid storing large binaries in DB.*



*Shard Elasticsearch appropriately; tune dense\_vector settings and memory.*



*Use caching (Redis) for frequent queries and embeddings.*



*15 — Implementation Roadmap — Milestones*



*Project scaffolding, environment, Docker compose skeleton.*



*Auth + MySQL schema + user management.*



*File upload endpoint + basic MySQL document record + audit logging.*



*Celery + Redis hook and a minimal worker that logs progress.*



*Implement text extraction for docx/pdf/image; update DB.*



*Integrate T5/BART summarization and HF NER (local proof-of-concept).*



*Add embeddings + Elasticsearch indexing + search endpoint.*



*Frontend pages: login, upload, search, viewer, workflow, analytics (static).*



*Workflow rules engine + approve/reject endpoints.*



*Hardening, tests, CI, monitoring, backups, documentation.*



*Load testing, tuning, production deployment.*



*16 — Deliverables (as requested)*



*/backend — Flask app structured by feature: api/, services/, models/, tasks/, auth/, db/, utils/. Include requirements.txt and Dockerfile.*



*/frontend — Plain HTML/CSS/JS (modular): pages, components, services/api.js for API calls, Tailwind integration, Recharts for analytics.*



*docker-compose.yml — starts: flask-api, frontend (nginx), mysql, elasticsearch, redis, celery-worker, celery-beat (optional), flower (optional).*



*README.md — detailed setup, run, env variables, migration, training/fine-tuning instructions, how to add Tesseract Malayalam pack, how to scale.*



*Test suite \& sample data (sample documents in /samples) and scripts to seed users/roles.*



*Optional: terraform scripts or manifests for k8s deployment if user later wants to move off Compose.*



*17 — Implementation Tips \& Model Recommendations*



*NER \& Summarization: Start with pretrained HF models (e.g., dbmdz/bert-large-cased-finetuned-conll03-english for NER as baseline) and google/mt5-small or facebook/bart-large-cnn for summarization — then fine-tune on KMRL-specific doc corpus.*



*Malayalam support: Use multilingual models (xlm-roberta, paraphrase-xlm-r for embeddings); Tesseract Malayalam pack mal.traineddata.*



*Embedding model: all-mpnet-base-v2 (English) or paraphrase-xlm-r-multilingual-v1 if many Malayalam docs.*



*Zero-shot: facebook/bart-large-mnli or HF zero-shot pipeline.*



*Chunking strategy: 1,000 token windows with overlap for large docs — produce chunk embeddings and store chunk metadata for per-chunk retrieval and highlight.*

