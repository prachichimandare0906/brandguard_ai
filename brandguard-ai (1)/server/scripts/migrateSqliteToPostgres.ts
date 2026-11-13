import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { initDatabase } from '../db.js';
import { createPostgresAdapter } from '../db/postgresAdapter.js';
import { ObjectStorageService } from '../services/objectStorage.js';

dotenv.config();

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main() {
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL is required to migrate data into PostgreSQL.');
    process.exit(1);
  }

  const sqlitePath = path.resolve(
    process.cwd(),
    getArgValue('--sqlite') || process.env.DATABASE_PATH || './data/brandguard.db'
  );

  if (!fs.existsSync(sqlitePath)) {
    console.error(`Error: SQLite database file not found at ${sqlitePath}`);
    process.exit(1);
  }

  console.log(`Opening source SQLite database (read/migrate source preserved): ${sqlitePath}`);
  const sqliteDb = initDatabase(sqlitePath);
  const pgDb = await createPostgresAdapter({ connectionString: databaseUrl, runMigrations: true });
  const storage = new ObjectStorageService();

  try {
    const orgs = sqliteDb.prepare('SELECT * FROM organisations').all() as any[];
    const users = sqliteDb.prepare('SELECT * FROM users').all() as any[];
    const members = sqliteDb.prepare('SELECT * FROM organisation_members').all() as any[];
    const sessions = sqliteDb.prepare('SELECT * FROM sessions').all() as any[];
    const guidelines = sqliteDb.prepare('SELECT * FROM guidelines').all() as any[];
    const facts = sqliteDb.prepare('SELECT * FROM approved_facts').all() as any[];
    const terms = sqliteDb.prepare('SELECT * FROM terminology').all() as any[];
    const assets = sqliteDb.prepare('SELECT * FROM assets').all() as any[];
    const storedFiles = sqliteDb.prepare('SELECT * FROM stored_files').all() as any[];
    const submissions = sqliteDb.prepare('SELECT * FROM submissions').all() as any[];
    const issues = sqliteDb.prepare('SELECT * FROM compliance_issues').all() as any[];
    const reviews = sqliteDb.prepare('SELECT * FROM reviews').all() as any[];
    const versions = sqliteDb.prepare('SELECT * FROM content_versions').all() as any[];
    const comments = sqliteDb.prepare('SELECT * FROM submission_comments').all() as any[];
    const auditLogs = sqliteDb.prepare('SELECT * FROM audit_logs').all() as any[];

    // Upload local stored_files payloads to S3 if configured before writing metadata rows
    const migratedFiles: Array<{
      row: any;
      storage_provider: string;
      bucket: string | null;
      object_key: string | null;
      data_base64: string | null;
    }> = [];

    for (const file of storedFiles) {
      if (file.data_base64 && storage.isConfigured()) {
        const buf = Buffer.from(file.data_base64, 'base64');
        const loc = await storage.uploadObject({
          orgId: file.org_id,
          fileId: file.id,
          fileName: file.filename,
          mimeType: file.mime_type,
          buffer: buf,
        });
        migratedFiles.push({
          row: file,
          storage_provider: 's3',
          bucket: loc.bucket,
          object_key: loc.objectKey,
          data_base64: null,
        });
      } else {
        migratedFiles.push({
          row: file,
          storage_provider: file.storage_provider || 'sqlite_dev',
          bucket: file.bucket || null,
          object_key: file.object_key || null,
          data_base64: file.data_base64 || null,
        });
      }
    }

    await pgDb.transaction(async (tx) => {
      for (const o of orgs) {
        await tx.query(
          `INSERT INTO organisations (id, name, slug, brand_settings, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (id) DO NOTHING`,
          [o.id, o.name, o.slug, o.brand_settings || '{}', o.created_at]
        );
      }

      for (const u of users) {
        await tx.query(
          `INSERT INTO users (id, name, email, password_hash, role, avatar, is_active, created_at, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            u.id,
            u.name,
            u.email,
            u.password_hash,
            u.role,
            u.avatar || null,
            Number(u.is_active ?? 1),
            u.created_at || new Date().toISOString(),
            u.last_login_at || null,
          ]
        );
      }

      for (const m of members) {
        await tx.query(
          `INSERT INTO organisation_members (id, org_id, user_id, role, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [m.id, m.org_id, m.user_id, m.role, m.created_at]
        );
      }

      for (const s of sessions) {
        await tx.query(
          `INSERT INTO sessions (id, user_id, active_org_id, token_hash, expires_at, revoked_at, ip_address, user_agent, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            s.id,
            s.user_id,
            s.active_org_id,
            s.token_hash,
            s.expires_at,
            s.revoked_at || null,
            s.ip_address || null,
            s.user_agent || null,
            s.created_at,
          ]
        );
      }

      for (const g of guidelines) {
        await tx.query(
          `INSERT INTO guidelines (id, org_id, title, category, description, severity, source_document, prohibited_phrase, preferred_replacement, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO NOTHING`,
          [
            g.id,
            g.org_id,
            g.title,
            g.category,
            g.description,
            g.severity,
            g.source_document || null,
            g.prohibited_phrase || null,
            g.preferred_replacement || null,
            g.created_at,
          ]
        );
      }

      for (const f of facts) {
        await tx.query(
          `INSERT INTO approved_facts (id, org_id, fact, source, verified_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [f.id, f.org_id, f.fact, f.source, f.verified_at, f.created_at]
        );
      }

      for (const t of terms) {
        await tx.query(
          `INSERT INTO terminology (id, org_id, prohibited_term, preferred_term, explanation, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [t.id, t.org_id, t.prohibited_term, t.preferred_term, t.explanation || '', t.created_at]
        );
      }

      for (const mf of migratedFiles) {
        const f = mf.row;
        await tx.query(
          `INSERT INTO stored_files (id, org_id, storage_provider, bucket, object_key, filename, mime_type, size_bytes, sha256, data_base64, uploaded_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO NOTHING`,
          [
            f.id,
            f.org_id,
            mf.storage_provider,
            mf.bucket,
            mf.object_key,
            f.filename,
            f.mime_type,
            f.size_bytes,
            f.sha256,
            mf.data_base64,
            f.uploaded_by || null,
            f.created_at,
          ]
        );
      }

      for (const a of assets) {
        await tx.query(
          `INSERT INTO assets (id, org_id, asset_name, asset_type, file_path, guidelines, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [a.id, a.org_id, a.asset_name, a.asset_type, a.file_path, a.guidelines || '', a.created_at]
        );
      }

      for (const sub of submissions) {
        await tx.query(
          `INSERT INTO submissions (id, org_id, title, content, original_content, content_type, created_by, status, compliance_score, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [
            sub.id,
            sub.org_id,
            sub.title,
            sub.content,
            sub.original_content,
            sub.content_type,
            sub.created_by,
            sub.status,
            sub.compliance_score,
            sub.created_at,
            sub.updated_at,
          ]
        );
      }

      for (const iss of issues) {
        await tx.query(
          `INSERT INTO compliance_issues (id, org_id, submission_id, title, category, severity, problematic_text, explanation, source_guideline_id, suggested_correction, confidence, human_status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO NOTHING`,
          [
            iss.id,
            iss.org_id,
            iss.submission_id,
            iss.title,
            iss.category,
            iss.severity,
            iss.problematic_text,
            iss.explanation,
            iss.source_guideline_id || null,
            iss.suggested_correction,
            iss.confidence || 'High',
            iss.human_status || 'Pending',
            iss.created_at,
          ]
        );
      }

      for (const rev of reviews) {
        await tx.query(
          `INSERT INTO reviews (id, org_id, submission_id, reviewer_id, decision, comments, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [rev.id, rev.org_id, rev.submission_id, rev.reviewer_id, rev.decision, rev.comments || null, rev.created_at]
        );
      }

      for (const v of versions) {
        await tx.query(
          `INSERT INTO content_versions (id, org_id, submission_id, version_number, content, created_by, change_summary, compliance_score, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            v.id,
            v.org_id,
            v.submission_id,
            v.version_number,
            v.content,
            v.created_by || null,
            v.change_summary || null,
            v.compliance_score ?? null,
            v.created_at,
          ]
        );
      }

      for (const c of comments) {
        await tx.query(
          `INSERT INTO submission_comments (id, org_id, submission_id, issue_id, author_id, body, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [c.id, c.org_id, c.submission_id, c.issue_id || null, c.author_id, c.body, c.created_at]
        );
      }

      for (const log of auditLogs) {
        await tx.query(
          `INSERT INTO audit_logs (id, org_id, actor_id, actor_role, action, entity_type, entity_id, details, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            log.id,
            log.org_id,
            log.actor_id || null,
            log.actor_role || null,
            log.action,
            log.entity_type,
            log.entity_id || null,
            log.details || '{}',
            log.created_at,
          ]
        );
      }
    });

    console.log('SQLite -> PostgreSQL migration completed successfully:', {
      organisations: orgs.length,
      users: users.length,
      organisation_members: members.length,
      sessions: sessions.length,
      guidelines: guidelines.length,
      approved_facts: facts.length,
      terminology: terms.length,
      stored_files: migratedFiles.length,
      assets: assets.length,
      submissions: submissions.length,
      compliance_issues: issues.length,
      reviews: reviews.length,
      content_versions: versions.length,
      submission_comments: comments.length,
      audit_logs: auditLogs.length,
    });
  } finally {
    sqliteDb.close();
    await pgDb.close();
  }
}

main().catch((err) => {
  console.error('SQLite -> PostgreSQL migration failed:', err);
  process.exit(1);
});
