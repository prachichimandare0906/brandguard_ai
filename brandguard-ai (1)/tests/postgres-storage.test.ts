import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';
import { createApp } from '../server/app.js';
import { createDatabaseAdapter } from '../server/db/index.js';
import { loadSqlMigrations, runPostgresMigrations } from '../server/db/postgresMigrator.js';
import { isDatabaseConnectionError, resolvePostgresSslConfig } from '../server/db/postgresAdapter.js';
import { createSqliteDevAdapter } from '../server/db/sqliteDevAdapter.js';
import { DbAdapter } from '../server/db/types.js';
import { ObjectStorageService } from '../server/services/objectStorage.js';
import { getSessionSecret } from '../server/services/authService.js';
import { ConfigurationError, DatabaseUnavailableError, StorageUnavailableError } from '../server/errors.js';

// -----------------------------------------------------------------------------
// 1. PRODUCTION GUARDRAILS (NO SQLITE, REQUIRE DATABASE_URL, SESSION_SECRET, S3)
// -----------------------------------------------------------------------------
test('Production environment strictly enforces PostgreSQL, SESSION_SECRET, and S3 storage', async () => {
  const prevEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    OBJECT_STORAGE_BUCKET: process.env.OBJECT_STORAGE_BUCKET,
  };

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    delete process.env.OBJECT_STORAGE_BUCKET;

    assert.throws(() => createSqliteDevAdapter(), ConfigurationError);
    assert.throws(() => getSessionSecret(), ConfigurationError);
    await assert.rejects(() => createDatabaseAdapter(), ConfigurationError);

    process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef';
    await assert.rejects(() => createApp({ storageService: new ObjectStorageService(null) }), ConfigurationError);
  } finally {
    process.env.NODE_ENV = prevEnv.NODE_ENV;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
    if (prevEnv.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevEnv.SESSION_SECRET;
    if (prevEnv.OBJECT_STORAGE_BUCKET === undefined) delete process.env.OBJECT_STORAGE_BUCKET;
    else process.env.OBJECT_STORAGE_BUCKET = prevEnv.OBJECT_STORAGE_BUCKET;
  }
});

// -----------------------------------------------------------------------------
// 2. VERSIONED POSTGRESQL MIGRATION RUNNER & CHECKSUM / LOCK VERIFICATION
// -----------------------------------------------------------------------------
test('PostgreSQL SQL migrations load cleanly and runner enforces advisory locks, checksums, and transactions', async () => {
  const migrations = loadSqlMigrations();
  assert.ok(migrations.length >= 2);
  assert.equal(migrations[0].id, '001_init_postgres');
  assert.equal(migrations[1].id, '002_audit_log_immutability');
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS audit_logs/);
  assert.match(migrations[0].sql, /CREATE INDEX IF NOT EXISTS idx_sessions_token_hash/);
  assert.match(migrations[1].sql, /CREATE TRIGGER trg_audit_logs_immutable/);

  const executedQueries: string[] = [];
  const appliedIds = new Map<string, string>();

  const spyClient = {
    async query(sql: string, params: any[] = []) {
      executedQueries.push(sql.trim());
      if (sql.includes('SELECT id, checksum FROM schema_migrations')) {
        return {
          rows: Array.from(appliedIds.entries()).map(([id, checksum]) => ({ id, checksum })),
        };
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        appliedIds.set(params[0], params[2]);
      }
      return { rows: [] };
    },
  };

  const firstRun = await runPostgresMigrations(spyClient as any);
  assert.deepEqual(
    firstRun,
    migrations.map((m) => m.id)
  );
  assert.ok(executedQueries.some((q) => q.includes('pg_advisory_lock')));
  assert.ok(executedQueries.some((q) => q.includes('pg_advisory_unlock')));

  // Second run is idempotent
  const secondRun = await runPostgresMigrations(spyClient as any);
  assert.deepEqual(secondRun, []);

  // Checksum mismatch raises error
  appliedIds.set(migrations[0].id, 'tampered-checksum');
  await assert.rejects(() => runPostgresMigrations(spyClient as any), /checksum mismatch/i);
});

test('PostgreSQL SSL resolver and connection error classifier behave safely', () => {
  assert.equal(resolvePostgresSslConfig('postgresql://user:pass@127.0.0.1:5432/db'), false);
  assert.deepEqual(resolvePostgresSslConfig('postgresql://user:pass@db.neon.tech:5432/db'), {
    rejectUnauthorized: false,
  });
  assert.equal(isDatabaseConnectionError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isDatabaseConnectionError({ code: '57P01' }), true);
  assert.equal(isDatabaseConnectionError({ code: '23505' }), false);
});

// -----------------------------------------------------------------------------
// 3. S3 OBJECT STORAGE ADAPTER & 503 ERROR HANDLING FOR DB/STORAGE OUTAGES
// -----------------------------------------------------------------------------
test('ObjectStorageService builds org-scoped S3 keys and returns 503 when unconfigured or failing', async () => {
  const unconfigured = new ObjectStorageService(null);
  assert.equal(unconfigured.isConfigured(), false);
  await assert.rejects(
    () =>
      unconfigured.uploadObject({
        orgId: 'ORG-123',
        fileId: 'FILE-1',
        fileName: 'Brand Logo.png',
        mimeType: 'image/png',
        buffer: Buffer.from('hello'),
      }),
    StorageUnavailableError
  );

  // Spy S3Client verifying AWS SDK v3 commands and org isolation
  const sentCommands: any[] = [];
  const storedObjects = new Map<string, Buffer>();
  const mockS3Client = {
    async send(cmd: any) {
      sentCommands.push(cmd);
      const name = cmd.constructor.name;
      if (name === 'PutObjectCommand') {
        storedObjects.set(cmd.input.Key, Buffer.from(cmd.input.Body));
        return {};
      }
      if (name === 'GetObjectCommand') {
        const buf = storedObjects.get(cmd.input.Key);
        if (!buf) throw new Error('NoSuchKey');
        return {
          Body: {
            transformToByteArray: async () => new Uint8Array(buf),
          },
        };
      }
      if (name === 'DeleteObjectCommand') {
        storedObjects.delete(cmd.input.Key);
        return {};
      }
      if (name === 'HeadBucketCommand') {
        return {};
      }
      return {};
    },
  } as unknown as S3Client;

  const s3Service = new ObjectStorageService(
    {
      bucket: 'brandguard-prod-bucket',
      region: 'us-east-1',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      forcePathStyle: false,
      prefix: 'tenant-files',
    },
    mockS3Client
  );

  assert.equal(s3Service.isConfigured(), true);
  const key = s3Service.buildOrgObjectKey('ORG-ALPHA', 'FILE-9', '../Brand Guidelines (v2).pdf');
  assert.equal(key, 'tenant-files/orgs/ORG-ALPHA/assets/FILE-9-Brand-Guidelines-v2-.pdf');

  const loc = await s3Service.uploadObject({
    orgId: 'ORG-ALPHA',
    fileId: 'FILE-9',
    fileName: 'logo.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png-binary-bytes'),
  });
  assert.equal(loc.bucket, 'brandguard-prod-bucket');
  assert.equal(loc.objectKey, 'tenant-files/orgs/ORG-ALPHA/assets/FILE-9-logo.png');

  const downloaded = await s3Service.downloadObject(loc.objectKey);
  assert.equal(downloaded.toString('utf-8'), 'png-binary-bytes');

  await s3Service.deleteObject(loc.objectKey);
  await assert.rejects(() => s3Service.downloadObject(loc.objectKey), StorageUnavailableError);
});

test('API returns HTTP 503 cleanly when database or object storage service is unavailable', async () => {
  const unavailableDbAdapter: DbAdapter = {
    dialect: 'postgres',
    async query() {
      throw new DatabaseUnavailableError('PostgreSQL database service is unavailable.');
    },
    async queryOne() {
      throw new DatabaseUnavailableError('PostgreSQL database service is unavailable.');
    },
    async transaction() {
      throw new DatabaseUnavailableError('PostgreSQL database service is unavailable.');
    },
    async healthCheck() {
      throw new DatabaseUnavailableError('PostgreSQL health check failed.');
    },
    async close() {},
  };

  const failingStorage = new ObjectStorageService(
    {
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyle: false,
      prefix: '',
    },
    {
      async send() {
        throw new Error('S3 network unreachable');
      },
    } as unknown as S3Client
  );

  const { app } = await createApp({
    dbAdapter: unavailableDbAdapter,
    storageService: failingStorage,
  });
  const server = app.listen(0);

  try {
    const port = (server.address() as AddressInfo).port;
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthRes.status, 503);
    const body = (await healthRes.json()) as any;
    assert.match(body.error, /unavailable|failed/i);

    const authRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', password: 'password123' }),
    });
    assert.equal(authRes.status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HTTP asset upload, org-isolated S3 download, delete cleanup, and 503 storage outage handling', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-s3-http-'));
  const dbPath = path.join(tmpDir, 's3-http.db');

  let failS3 = false;
  const s3Store = new Map<string, Buffer>();
  const mockS3 = {
    async send(cmd: any) {
      if (failS3) throw new Error('Simulated S3 outage');
      const name = cmd.constructor.name;
      if (name === 'PutObjectCommand') {
        s3Store.set(cmd.input.Key, Buffer.from(cmd.input.Body));
        return {};
      }
      if (name === 'GetObjectCommand') {
        const buf = s3Store.get(cmd.input.Key);
        if (!buf) throw new Error('NoSuchKey');
        return { Body: { transformToByteArray: async () => new Uint8Array(buf) } };
      }
      if (name === 'DeleteObjectCommand') {
        s3Store.delete(cmd.input.Key);
        return {};
      }
      if (name === 'HeadBucketCommand') return {};
      return {};
    },
  } as unknown as S3Client;

  const storage = new ObjectStorageService(
    {
      bucket: 'bg-test-bucket',
      region: 'us-east-1',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      forcePathStyle: false,
      prefix: '',
    },
    mockS3
  );

  const { app, db } = await createApp({ dbPath, storageService: storage });
  const server = app.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Register Org A and Org B admins
    const regA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'S3 Admin A',
        email: 's3a@test.local',
        password: 'StrongPassword!1',
        orgName: 'S3 Org A',
        seedStarterBrand: false,
      }),
    });
    const cookieA = (regA.headers.get('set-cookie') || '').split(';')[0];

    const regB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'S3 Admin B',
        email: 's3b@test.local',
        password: 'StrongPassword!1',
        orgName: 'S3 Org B',
        seedStarterBrand: false,
      }),
    });
    const cookieB = (regB.headers.get('set-cookie') || '').split(';')[0];

    // Upload asset to Org A -> stores bytes in S3, metadata in DB
    const payloadText = 'PNG-OR-SVG-TEST-CONTENT';
    const uploadRes = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({
        asset_name: 'Primary Brand Mark',
        asset_type: 'Logo',
        fileName: 'brand-mark.svg',
        mimeType: 'image/svg+xml',
        fileBase64: Buffer.from(payloadText).toString('base64'),
      }),
    });
    assert.equal(uploadRes.status, 201);
    const asset = (await uploadRes.json()) as any;
    assert.match(asset.file_path, /^\/api\/files\/FILE-/);
    assert.equal(s3Store.size, 1);

    // Org A downloads successfully
    const downloadA = await fetch(`${baseUrl}${asset.file_path}`, { headers: { Cookie: cookieA } });
    assert.equal(downloadA.status, 200);
    assert.equal(await downloadA.text(), payloadText);

    // Org B cannot access Org A's stored file (404)
    const downloadB = await fetch(`${baseUrl}${asset.file_path}`, { headers: { Cookie: cookieB } });
    assert.equal(downloadB.status, 404);

    // Unauthenticated download returns 401
    const downloadAnon = await fetch(`${baseUrl}${asset.file_path}`);
    assert.equal(downloadAnon.status, 401);

    // Simulated S3 outage returns 503 cleanly
    failS3 = true;
    const outageDownload = await fetch(`${baseUrl}${asset.file_path}`, { headers: { Cookie: cookieA } });
    assert.equal(outageDownload.status, 503);
    const outageHealth = await fetch(`${baseUrl}/api/health`);
    assert.equal(outageHealth.status, 503);

    // Recover S3 and delete asset -> removes object from S3
    failS3 = false;
    const delRes = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookieA },
    });
    assert.equal(delRes.status, 200);
    assert.equal(s3Store.size, 0);
  } finally {
    await db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// 4. LIVE POSTGRESQL + S3 PERSISTENCE & RESTART INTEGRATION TESTS
//    (Runs only when real DATABASE_URL is configured; never fakes Postgres!)
// -----------------------------------------------------------------------------
const liveDatabaseUrl = (process.env.DATABASE_URL || '').trim();

test(
  'Live PostgreSQL integration: migrations, data/session persistence across restart, org isolation, and audit immutability',
  { skip: !liveDatabaseUrl ? 'DATABASE_URL not configured in environment' : false },
  async () => {
    const prevSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'live-postgres-test-session-secret-key-32';

    const tmpEmail = `pg-test-${Date.now()}@example.com`;
    const orgAName = `PG Test Org A ${Date.now()}`;
    const orgBName = `PG Test Org B ${Date.now()}`;

    let cookieA = '';
    let subId = '';

    // Boot 1: register user, create submission, verify session
    const boot1 = await createApp({ databaseUrl: liveDatabaseUrl });
    const server1 = boot1.app.listen(0);
    try {
      const url1 = `http://127.0.0.1:${(server1.address() as AddressInfo).port}`;

      const regRes = await fetch(`${url1}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'PG Admin',
          email: tmpEmail,
          password: 'PgTestPassword!123',
          orgName: orgAName,
          seedStarterBrand: true,
        }),
      });
      assert.equal(regRes.status, 201);
      const setCookie = regRes.headers.get('set-cookie') || '';
      cookieA = setCookie.split(';')[0];
      assert.ok(cookieA.startsWith('bg_session='));

      const subRes = await fetch(`${url1}/api/submissions/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieA },
        body: JSON.stringify({
          title: 'PG Restart Persistence Draft',
          content_type: 'Website Copy',
          content: 'Dear customers, our platform is engineered for reliability.',
        }),
      });
      assert.equal(subRes.status, 200);
      subId = ((await subRes.json()) as any).submission.id;
    } finally {
      await boot1.db.close();
      await new Promise<void>((resolve) => server1.close(() => resolve()));
    }

    // Boot 2 (simulates full server restart with new Express + pg.Pool instance)
    const boot2 = await createApp({ databaseUrl: liveDatabaseUrl });
    const server2 = boot2.app.listen(0);
    try {
      const url2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;

      // Existing session cookie must remain valid after restart
      const meRes = await fetch(`${url2}/api/auth/me`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(meRes.status, 200);

      // Submission must persist in PostgreSQL across restart
      const subFetch = await fetch(`${url2}/api/submissions/${subId}`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(subFetch.status, 200);

      // Register second isolated org and verify cross-org denial
      const regB = await fetch(`${url2}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'PG Rival',
          email: `rival-${Date.now()}@example.com`,
          password: 'PgRivalPassword!123',
          orgName: orgBName,
          seedStarterBrand: false,
        }),
      });
      assert.equal(regB.status, 201);
      const cookieB = (regB.headers.get('set-cookie') || '').split(';')[0];

      const crossOrgSub = await fetch(`${url2}/api/submissions/${subId}`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(crossOrgSub.status, 404);

      // Verify PostgreSQL audit_logs immutability trigger rejects DELETE
      await assert.rejects(
        () => boot2.db.query("DELETE FROM audit_logs WHERE entity_id = $1", [subId]),
        /immutable/i
      );
    } finally {
      await boot2.db.close();
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      if (prevSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSecret;
    }
  }
);
