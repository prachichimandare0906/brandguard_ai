import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header to be present');
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const sessionCookie = headers.find((h) => h.startsWith('bg_session='));
  assert.ok(sessionCookie, 'Expected bg_session cookie');
  return sessionCookie.split(';')[0];
}

async function requestJson(
  baseUrl: string,
  method: string,
  route: string,
  options: {
    cookie?: string;
    orgId?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers['Cookie'] = options.cookie;
  if (options.orgId) headers['X-Org-Id'] = options.orgId;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    data: parsed,
  };
}

// -----------------------------------------------------------------------------
// SUITE 1: LEGACY ROUND 2 DATABASE MIGRATION PRESERVATION
// -----------------------------------------------------------------------------
test('Legacy Round 2 SQLite migration preserves all rows and scrubs mock password hashes', async () => {
  const sourceDbPath = path.resolve(process.cwd(), 'data', 'brandguard.db');
  if (!fs.existsSync(sourceDbPath)) {
    return; // Skip only if running in an environment without pre-existing Round 2 DB
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-migration-test-'));
  const copiedDbPath = path.join(tmpDir, 'legacy-copy.db');
  fs.copyFileSync(sourceDbPath, copiedDbPath);
  if (fs.existsSync(`${sourceDbPath}-wal`)) {
    fs.copyFileSync(`${sourceDbPath}-wal`, `${copiedDbPath}-wal`);
  }
  if (fs.existsSync(`${sourceDbPath}-shm`)) {
    fs.copyFileSync(`${sourceDbPath}-shm`, `${copiedDbPath}-shm`);
  }

  const { app, db } = await createApp({ dbPath: copiedDbPath });
  const server = app.listen(0);

  try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Verify counts preserved
    const counts = {
      users: (await db.queryOne<any>('SELECT COUNT(*) as c FROM users')).c,
      guidelines: (await db.queryOne<any>('SELECT COUNT(*) as c FROM guidelines')).c,
      facts: (await db.queryOne<any>('SELECT COUNT(*) as c FROM approved_facts')).c,
      terminology: (await db.queryOne<any>('SELECT COUNT(*) as c FROM terminology')).c,
      assets: (await db.queryOne<any>('SELECT COUNT(*) as c FROM assets')).c,
      submissions: (await db.queryOne<any>('SELECT COUNT(*) as c FROM submissions')).c,
      issues: (await db.queryOne<any>('SELECT COUNT(*) as c FROM compliance_issues')).c,
      reviews: (await db.queryOne<any>('SELECT COUNT(*) as c FROM reviews')).c,
      versions: (await db.queryOne<any>('SELECT COUNT(*) as c FROM content_versions')).c,
    };

    assert.ok(Number(counts.users) >= 3, 'Expected legacy users preserved');
    assert.ok(Number(counts.guidelines) >= 8, 'Expected legacy guidelines preserved');
    assert.ok(Number(counts.facts) >= 4, 'Expected legacy approved_facts preserved');
    assert.ok(Number(counts.terminology) >= 5, 'Expected legacy terminology preserved');
    assert.ok(Number(counts.assets) >= 3, 'Expected legacy assets preserved');
    assert.ok(Number(counts.submissions) >= 3, 'Expected legacy submissions preserved');
    assert.ok(Number(counts.issues) >= 11, 'Expected legacy compliance_issues preserved');
    assert.ok(Number(counts.reviews) >= 2, 'Expected legacy reviews preserved');
    assert.ok(Number(counts.versions) >= 3, 'Expected legacy content_versions preserved');

    // Verify all legacy records were assigned to org-novatech
    const nullOrgGuidelines = Number(
      (await db.queryOne<any>('SELECT COUNT(*) as c FROM guidelines WHERE org_id IS NULL')).c
    );
    const nullOrgSubmissions = Number(
      (await db.queryOne<any>('SELECT COUNT(*) as c FROM submissions WHERE org_id IS NULL')).c
    );
    assert.equal(nullOrgGuidelines, 0);
    assert.equal(nullOrgSubmissions, 0);

    // Verify memberships created
    const memberCount = Number(
      (await db.queryOne<any>("SELECT COUNT(*) as c FROM organisation_members WHERE org_id = 'org-novatech'")).c
    );
    assert.equal(memberCount, Number(counts.users));

    // Verify asset paths migrated off /src/assets/images/
    const brokenAssets = Number(
      (await db.queryOne<any>("SELECT COUNT(*) as c FROM assets WHERE file_path LIKE '/src/assets/%'")).c
    );
    assert.equal(brokenAssets, 0);

    // Verify insecure mock hashes were scrubbed
    const mockHashes = Number(
      (await db.queryOne<any>("SELECT COUNT(*) as c FROM users WHERE password_hash LIKE 'pbkdf2$e1$mock%'")).c
    );
    assert.equal(mockHashes, 0);

    // Verify legacy mock account cannot log in with an arbitrary/placeholder password
    const legacyLoginRes = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'sarah.chen@novatech.com', password: 'password123' },
    });
    assert.equal(legacyLoginRes.status, 401);
  } finally {
    await db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// SUITE 2: AUTHENTICATION, SESSIONS, RBAC & CROSS-ORG ISOLATION
// -----------------------------------------------------------------------------
describeAppSecuritySuite();

function describeAppSecuritySuite() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-sec-test-'));
  const testDbPath = path.join(tmpDir, 'security-test.db');

  let server: http.Server;
  let baseUrl: string;
  let dbClose: () => Promise<void>;

  let orgAId = '';
  let orgBId = '';
  let adminACookie = '';
  let creatorACookie = '';
  let managerACookie = '';
  let adminBCookie = '';

  let creatorASubmissionId = '';
  let managerASubmissionId = '';
  let adminAFactId = '';
  let orgAGuidelineId = '';

  before(async () => {
    // Ensure deterministic rule fallback during tests without relying on external Gemini network
    delete process.env.GEMINI_API_KEY;
    const { app, db } = await createApp({ dbPath: testDbPath });
    dbClose = () => db.close();
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await dbClose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('1. Health endpoint is public and reports ok', async () => {
    const res = await requestJson(baseUrl, 'GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');
  });

  test('2. Unauthenticated requests to protected routes return 401', async () => {
    const protectedEndpoints: Array<[string, string]> = [
      ['GET', '/api/auth/me'],
      ['GET', '/api/guidelines'],
      ['GET', '/api/facts'],
      ['GET', '/api/terminology'],
      ['GET', '/api/assets'],
      ['GET', '/api/submissions'],
      ['GET', '/api/analytics'],
      ['GET', '/api/audit-logs'],
      ['POST', '/api/reset-demo'],
    ];

    for (const [method, route] of protectedEndpoints) {
      const res = await requestJson(baseUrl, method, route);
      assert.equal(res.status, 401, `Expected 401 for unauthenticated ${method} ${route}`);
    }
  });

  test('3. Register, login, invalid password rejection, and session verification', async () => {
    const regRes = await requestJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        name: 'Alice Admin',
        email: 'alice@orga.test',
        password: 'StrongPassword!123',
        orgName: 'Alpha Governance Org',
        seedStarterBrand: true,
      },
    });
    assert.equal(regRes.status, 201);
    assert.equal(regRes.data.role, 'admin');
    orgAId = regRes.data.activeOrg.orgId;
    assert.ok(orgAId);

    const regSetCookie = regRes.headers['set-cookie'];
    assert.ok(String(regSetCookie).toLowerCase().includes('httponly'));
    adminACookie = extractSessionCookie(regSetCookie);

    // Bad password login fails with 401
    const badLogin = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'alice@orga.test', password: 'WrongPassword!' },
    });
    assert.equal(badLogin.status, 401);

    // Valid login succeeds and issues fresh session cookie
    const goodLogin = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'alice@orga.test', password: 'StrongPassword!123' },
    });
    assert.equal(goodLogin.status, 200);
    assert.equal(goodLogin.data.user.email, 'alice@orga.test');
    assert.equal(goodLogin.data.activeOrg.orgId, orgAId);
    adminACookie = extractSessionCookie(goodLogin.headers['set-cookie']);

    // /api/auth/me works with cookie
    const meRes = await requestJson(baseUrl, 'GET', '/api/auth/me', { cookie: adminACookie });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.activeOrg.orgId, orgAId);
  });

  test('4. Logout revokes session and prevents token reuse', async () => {
    const loginRes = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'alice@orga.test', password: 'StrongPassword!123' },
    });
    const tempCookie = extractSessionCookie(loginRes.headers['set-cookie']);

    const beforeLogout = await requestJson(baseUrl, 'GET', '/api/auth/me', { cookie: tempCookie });
    assert.equal(beforeLogout.status, 200);

    const logoutRes = await requestJson(baseUrl, 'POST', '/api/auth/logout', { cookie: tempCookie });
    assert.equal(logoutRes.status, 200);
    assert.ok(String(logoutRes.headers['set-cookie']).includes('Max-Age=0'));

    const afterLogout = await requestJson(baseUrl, 'GET', '/api/auth/me', { cookie: tempCookie });
    assert.equal(afterLogout.status, 401);
  });

  test('5. Admin provisions Creator & Brand Manager and RBAC is strictly enforced', async () => {
    // Admin creates Creator and Brand Manager in Org A
    const addCreator = await requestJson(baseUrl, 'POST', `/api/orgs/${orgAId}/members`, {
      cookie: adminACookie,
      orgId: orgAId,
      body: {
        name: 'Charlie Creator',
        email: 'charlie@orga.test',
        password: 'CreatorPassword!1',
        role: 'creator',
      },
    });
    assert.equal(addCreator.status, 201);

    const addManager = await requestJson(baseUrl, 'POST', `/api/orgs/${orgAId}/members`, {
      cookie: adminACookie,
      orgId: orgAId,
      body: {
        name: 'Maya Manager',
        email: 'maya@orga.test',
        password: 'ManagerPassword!1',
        role: 'brand_manager',
      },
    });
    assert.equal(addManager.status, 201);

    // Admin creates a guideline & fact for later tests
    const createGuidelineRes = await requestJson(baseUrl, 'POST', '/api/guidelines', {
      cookie: adminACookie,
      orgId: orgAId,
      body: {
        title: 'Org A Strict Tone Policy',
        category: 'Tone',
        description: 'Maintain calm technical clarity.',
        severity: 'Medium',
      },
    });
    assert.equal(createGuidelineRes.status, 201);
    orgAGuidelineId = createGuidelineRes.data.id;

    const createFactRes = await requestJson(baseUrl, 'POST', '/api/facts', {
      cookie: adminACookie,
      orgId: orgAId,
      body: { fact: 'Alpha Org holds SOC 2 Type II.', source: 'Trust Report 2026' },
    });
    assert.equal(createFactRes.status, 201);
    adminAFactId = createFactRes.data.id;

    // Sign in as Creator and Brand Manager
    const creatorLogin = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'charlie@orga.test', password: 'CreatorPassword!1' },
    });
    assert.equal(creatorLogin.status, 200);
    creatorACookie = extractSessionCookie(creatorLogin.headers['set-cookie']);

    const managerLogin = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'maya@orga.test', password: 'ManagerPassword!1' },
    });
    assert.equal(managerLogin.status, 200);
    managerACookie = extractSessionCookie(managerLogin.headers['set-cookie']);

    // Creator cannot mutate guidelines, facts, org members, audit logs, or reset starter data
    assert.equal(
      (
        await requestJson(baseUrl, 'POST', '/api/guidelines', {
          cookie: creatorACookie,
          body: { title: 'X', category: 'Tone', description: 'Y', severity: 'Low' },
        })
      ).status,
      403
    );
    assert.equal(
      (
        await requestJson(baseUrl, 'DELETE', `/api/facts/${adminAFactId}`, {
          cookie: creatorACookie,
        })
      ).status,
      403
    );
    assert.equal(
      (
        await requestJson(baseUrl, 'POST', `/api/orgs/${orgAId}/members`, {
          cookie: creatorACookie,
          body: { name: 'X', email: 'x@orga.test', password: 'Password123!', role: 'admin' },
        })
      ).status,
      403
    );
    assert.equal(
      (await requestJson(baseUrl, 'GET', '/api/audit-logs', { cookie: creatorACookie })).status,
      403
    );
    assert.equal(
      (await requestJson(baseUrl, 'POST', '/api/reset-demo', { cookie: creatorACookie })).status,
      403
    );

    // Brand Manager CAN manage Knowledge Hub policies (guidelines, facts, terminology, assets)
    const mgrGuidelineRes = await requestJson(baseUrl, 'POST', '/api/guidelines', {
      cookie: managerACookie,
      body: {
        title: 'Manager Brand Voice Policy',
        category: 'Tone',
        description: 'Ensure product claims align with verified trust materials.',
        severity: 'Medium',
      },
    });
    assert.equal(mgrGuidelineRes.status, 201);

    // Brand Manager CANNOT mutate Admin-only org settings, team members, or workspace reset
    assert.equal(
      (
        await requestJson(baseUrl, 'PUT', '/api/org/brand-settings', {
          cookie: managerACookie,
          body: { primaryColors: ['#0F172A'], approvedFonts: ['Plus Jakarta Sans'] },
        })
      ).status,
      403
    );
    assert.equal(
      (
        await requestJson(baseUrl, 'POST', `/api/orgs/${orgAId}/members`, {
          cookie: managerACookie,
          body: { name: 'Y', email: 'y@orga.test', password: 'Password123!', role: 'creator' },
        })
      ).status,
      403
    );
    assert.equal(
      (await requestJson(baseUrl, 'POST', '/api/reset-demo', { cookie: managerACookie })).status,
      403
    );

    // Creator analyzes content -> edits draft -> adds comment -> submits for review
    const analyzeRes = await requestJson(baseUrl, 'POST', '/api/submissions/analyze', {
      cookie: creatorACookie,
      body: {
        title: 'Q2 Product Announcement',
        content_type: 'Email Campaign',
        content: 'Attention users: our cheap solution guarantees results!',
      },
    });
    assert.equal(analyzeRes.status, 200);
    creatorASubmissionId = analyzeRes.data.submission.id;
    assert.equal(analyzeRes.data.submission.status, 'Draft');
    assert.ok(analyzeRes.data.issues.length > 0);

    const patchRes = await requestJson(baseUrl, 'PATCH', `/api/submissions/${creatorASubmissionId}/content`, {
      cookie: creatorACookie,
      body: {
        content: 'Dear customers, our cost-effective solution is designed to deliver measurable value.',
        change_summary: 'Replaced prohibited terminology and guarantees',
      },
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.data.version_number, 2);

    const commentRes = await requestJson(baseUrl, 'POST', `/api/submissions/${creatorASubmissionId}/comments`, {
      cookie: creatorACookie,
      body: { body: 'Updated copy per brand terminology policy.' },
    });
    assert.equal(commentRes.status, 201);

    const submitRes = await requestJson(baseUrl, 'POST', `/api/submissions/${creatorASubmissionId}/submit-review`, {
      cookie: creatorACookie,
    });
    assert.equal(submitRes.status, 200);
    assert.equal(submitRes.data.submission.status, 'In Review');

    // Creator cannot approve their own or any submission (403)
    const creatorSelfApprove = await requestJson(baseUrl, 'POST', `/api/submissions/${creatorASubmissionId}/review`, {
      cookie: creatorACookie,
      body: { decision: 'Approved', comments: 'Self approve attempt' },
    });
    assert.equal(creatorSelfApprove.status, 403);

    // Brand Manager rejects without comment -> 400
    const rejectNoComment = await requestJson(baseUrl, 'POST', `/api/submissions/${creatorASubmissionId}/review`, {
      cookie: managerACookie,
      body: { decision: 'Rejected', comments: '   ' },
    });
    assert.equal(rejectNoComment.status, 400);

    // Brand Manager approves peer submission -> 200
    const approveRes = await requestJson(baseUrl, 'POST', `/api/submissions/${creatorASubmissionId}/review`, {
      cookie: managerACookie,
      body: { decision: 'Approved', comments: 'Compliant terminology and verifiable messaging.' },
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.data.submission.status, 'Approved');

    // Anti-self-approval: Brand Manager creates & submits their own draft -> cannot approve it themselves
    const mgrAnalyze = await requestJson(baseUrl, 'POST', '/api/submissions/analyze', {
      cookie: managerACookie,
      body: {
        title: 'Manager Draft',
        content_type: 'Social Media',
        content: 'Alpha Governance Org serves enterprise customers.',
      },
    });
    managerASubmissionId = mgrAnalyze.data.submission.id;
    await requestJson(baseUrl, 'POST', `/api/submissions/${managerASubmissionId}/submit-review`, {
      cookie: managerACookie,
    });

    const mgrSelfApprove = await requestJson(baseUrl, 'POST', `/api/submissions/${managerASubmissionId}/review`, {
      cookie: managerACookie,
      body: { decision: 'Approved', comments: 'Attempting self approval' },
    });
    assert.equal(mgrSelfApprove.status, 403);

    // Brand Manager can read org audit logs
    const mgrAudit = await requestJson(baseUrl, 'GET', '/api/audit-logs', { cookie: managerACookie });
    assert.equal(mgrAudit.status, 200);
    assert.ok(mgrAudit.data.logs.length > 0);
  });

  test('6. Cross-organisation data isolation prevents reading or mutating another tenant', async () => {
    const regBRes = await requestJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        name: 'Bob Rival',
        email: 'bob@orgb.test',
        password: 'RivalPassword!123',
        orgName: 'Beta Isolated Corp',
        seedStarterBrand: false,
      },
    });
    assert.equal(regBRes.status, 201);
    orgBId = regBRes.data.activeOrg.orgId;
    assert.notEqual(orgBId, orgAId);
    adminBCookie = extractSessionCookie(regBRes.headers['set-cookie']);

    // Spoofing X-Org-Id header for Org A returns 403
    const spoofSubs = await requestJson(baseUrl, 'GET', '/api/submissions', {
      cookie: adminBCookie,
      orgId: orgAId,
    });
    assert.equal(spoofSubs.status, 403);

    const spoofMembers = await requestJson(baseUrl, 'GET', `/api/orgs/${orgAId}/members`, {
      cookie: adminBCookie,
    });
    assert.equal(spoofMembers.status, 403);

    // Under own Org B session, Org A resources are invisible (empty list or 404 by ID)
    const orgBSubs = await requestJson(baseUrl, 'GET', '/api/submissions', { cookie: adminBCookie });
    assert.equal(orgBSubs.status, 200);
    assert.equal(orgBSubs.data.length, 0);

    const fetchOrgASub = await requestJson(baseUrl, 'GET', `/api/submissions/${creatorASubmissionId}`, {
      cookie: adminBCookie,
    });
    assert.equal(fetchOrgASub.status, 404);

    const deleteOrgAGuideline = await requestJson(baseUrl, 'DELETE', `/api/guidelines/${orgAGuidelineId}`, {
      cookie: adminBCookie,
    });
    assert.equal(deleteOrgAGuideline.status, 404);

    const orgBAnalytics = await requestJson(baseUrl, 'GET', '/api/analytics', { cookie: adminBCookie });
    assert.equal(orgBAnalytics.status, 200);
    assert.equal(orgBAnalytics.data.metrics.totalSubmissions, 0);

    // Org B audit logs must contain ONLY Org B events
    const orgBAudit = await requestJson(baseUrl, 'GET', '/api/audit-logs', { cookie: adminBCookie });
    assert.equal(orgBAudit.status, 200);
    for (const entry of orgBAudit.data.logs) {
      assert.equal(entry.org_id, orgBId);
    }
  });
}
