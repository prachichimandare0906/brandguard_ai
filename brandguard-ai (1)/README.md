# BrandGuard AI · Enterprise Brand Governance Platform

BrandGuard AI is a multi-tenant enterprise brand governance platform built to verify marketing and corporate communications against approved brand guidelines, verified facts, corporate terminology, and visual assets before human sign-off.

---

## 1. Architecture Summary

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, Lucide React, Recharts
- **Backend:** Express (`server.ts` / `server/app.ts`)
- **Database:**
  - **Production:** Managed PostgreSQL via `pg` + `pg.Pool` and versioned SQL migrations (`server/db/migrations/*.sql`)
  - **Local Development Fallback:** Local SQLite (`better-sqlite3`, `DATABASE_PATH`) used only when `NODE_ENV !== "production"` and `DATABASE_URL` is unset
- **Persistent Document & Asset Storage:** S3-compatible object storage via `@aws-sdk/client-s3` (`server/services/objectStorage.ts`) with org-scoped object keys (`orgs/<orgId>/assets/...`) and authenticated proxy downloads (`/api/files/:id`)
- **Authentication & Security:** `crypto.scryptSync` salted password hashing, `timingSafeEqual` verification, HMAC-SHA256 database-backed sessions (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS), strict `org_id` tenant isolation, server-enforced `creator` / `brand_manager` / `admin` RBAC, anti-self-approval, and immutable `audit_logs`
- **AI & Compliance Fallback:** Server-side Google Gemini (`@google/genai`) with deterministic rule-based fallback (`server/ruleFallback.ts`)

---

## 2. Environment Variables (Backend Only)

Configure these in `.env` (local) or your hosting provider's Secrets Manager (production). Never expose secrets in frontend (`VITE_*`) variables.

| Variable | Required in Production | Purpose |
| :--- | :---: | :--- |
| `NODE_ENV` | Yes (`production`) | Disables Vite dev middleware and enforces PostgreSQL, `SESSION_SECRET`, and S3 storage |
| `PORT` | Yes (`3000`) | HTTP listening port |
| `SESSION_SECRET` | Yes (32+ chars) | HMAC key for session token hashing; ensures sessions survive restarts |
| `SESSION_TTL_HOURS` | No (default `24`) | Session expiration window in hours |
| `CORS_ORIGINS` | Cross-origin only | Comma-separated permitted frontend origins for credentialed CORS |
| `COOKIE_SAMESITE` | No (default auto) | Optional HTTPS override (`lax`, `strict`, `none`); auto uses `Partitioned` in cross-site iframes |
| `DATABASE_URL` | Yes | PostgreSQL connection string (`postgresql://...`) |
| `DATABASE_SSL` | Recommended (`require`) | TLS mode (`require`, `verify-full`, `no-verify`, `disable`) |
| `DATABASE_POOL_MAX` | No (default `10`) | Maximum `pg.Pool` connections |
| `OBJECT_STORAGE_BUCKET` | Yes | Private S3-compatible bucket name |
| `OBJECT_STORAGE_REGION` | Yes | Bucket region (`us-east-1`, `auto` for R2, etc.) |
| `OBJECT_STORAGE_ENDPOINT` | Provider-dependent | Custom S3 endpoint for R2, MinIO, Supabase S3, or GCS HMAC |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | Yes | Backend storage access key |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | Yes | Backend storage secret key |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | No (`false`) | Set `true` for MinIO / path-style S3 endpoints |
| `OBJECT_STORAGE_PREFIX` | No | Optional object key prefix |
| `GEMINI_API_KEY` | Optional | Enables live Gemini compliance analysis (rule engine fallback runs if omitted) |
| `DATABASE_PATH` | Local dev only | Path to local SQLite DB (`./data/brandguard.db`) for dev or SQLite->PG import |

---

## 3. Local Development Setup

### Option A: Local Development with Local PostgreSQL + MinIO (Recommended Parity)
1. Start local PostgreSQL 16 and MinIO (e.g., via Docker):
   ```bash
   docker run -d --name bg-postgres -e POSTGRES_USER=brandguard -e POSTGRES_PASSWORD=localdevpass -e POSTGRES_DB=brandguard -p 5432:5432 postgres:16
   docker run -d --name bg-minio -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin -p 9000:9000 -p 9001:9001 minio/minio server /data --console-address ":9001"
   ```
2. Create a private bucket (e.g. `brandguard-assets`) in MinIO Console (`http://localhost:9001`).
3. Configure `.env` from `.env.example`:
   ```env
   NODE_ENV="development"
   SESSION_SECRET="replace-with-local-32-char-random-secret"
   DATABASE_URL="postgresql://brandguard:localdevpass@127.0.0.1:5432/brandguard"
   DATABASE_SSL="disable"
   OBJECT_STORAGE_BUCKET="brandguard-assets"
   OBJECT_STORAGE_REGION="us-east-1"
   OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:9000"
   OBJECT_STORAGE_ACCESS_KEY_ID="minioadmin"
   OBJECT_STORAGE_SECRET_ACCESS_KEY="minioadmin"
   OBJECT_STORAGE_FORCE_PATH_STYLE="true"
   ```
4. Install dependencies, run migrations, and start the dev server:
   ```bash
   npm install
   npm run db:migrate
   npm run dev
   ```

### Option B: Offline Local Development (Without External DB/S3)
If `DATABASE_URL` is omitted while `NODE_ENV="development"`, the server automatically runs against `./data/brandguard.db` so UI and rule-engine development work offline. This fallback is strictly disabled when `NODE_ENV="production"`.

---

## 4. Migrating Existing SQLite Data to PostgreSQL

Existing Round 2/Phase 1 records in `data/brandguard.db` (users, organisations, memberships, sessions, guidelines, facts, terminology, assets, submissions, revisions, comments, audit logs, and stored files) can be transferred into PostgreSQL idempotently without deleting the local SQLite file:

```bash
# Ensure DATABASE_URL (and optional OBJECT_STORAGE_* vars) are set in .env
npm run db:migrate
npm run db:migrate-sqlite
```

---

## 5. Verification & Testing Commands

```bash
# Type check
npm run lint

# Build production client bundle
npm run build

# Run automated security, migration, and storage tests
# (Live PostgreSQL & S3 integration assertions activate automatically when DATABASE_URL and OBJECT_STORAGE_* are set)
npm test
```

---

## 6. Production Deployment Instructions

1. Provision a **managed PostgreSQL 15+ database** (e.g. Neon, Supabase, AWS RDS, or Cloud SQL) with TLS enabled.
2. Provision a **private S3-compatible object storage bucket** (AWS S3, Cloudflare R2, or GCS HMAC) with least-privilege read/write/delete IAM credentials scoped to that bucket.
3. Generate a strong `SESSION_SECRET` (`openssl rand -hex 32`) and set all required production environment variables in your hosting platform's secret manager (`NODE_ENV=production`, `DATABASE_URL`, `DATABASE_SSL=require`, `SESSION_SECRET`, `OBJECT_STORAGE_*`, and `GEMINI_API_KEY`).
4. Run schema migrations once before or during release:
   ```bash
   npm run db:migrate
   ```
5. Build and start the server:
   ```bash
   npm run build
   npm start
   ```
6. Verify deployment readiness via `GET /api/health` (confirms PostgreSQL pool connectivity and S3 bucket reachability).
