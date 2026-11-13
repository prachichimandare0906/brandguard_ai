import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const sessionCookie = headers.find((h) => h.startsWith('bg_session='));
  assert.ok(sessionCookie, 'Expected bg_session cookie');
  return sessionCookie.split(';')[0];
}

async function requestJson(
  baseUrl: string,
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers['Cookie'] = options.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), data };
}

// Minimal valid PDF with 1 empty graphics page (simulates a scanned image-only PDF with zero extractable text)
function createBlankTextlessPdf(): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

describeRagEvidenceSuite();

function describeRagEvidenceSuite() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-rag-test-'));
  const testDbPath = path.join(tmpDir, 'rag-test.db');

  let server: http.Server;
  let baseUrl: string;
  let dbClose: () => Promise<void>;

  let orgAId = '';
  let adminACookie = '';
  let managerACookie = '';
  let creatorACookie = '';
  let adminBCookie = '';
  let ingestedTxtDocId = '';

  before(async () => {
    delete process.env.GEMINI_API_KEY;
    const { app, db } = await createApp({ dbPath: testDbPath });
    dbClose = () => db.close();
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Org A with seeded rules
    const regA = await requestJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        name: 'Alice RAG Admin',
        email: 'alice@rag-a.test',
        password: 'StrongPassword!123',
        orgName: 'Alpha RAG Org',
        seedStarterBrand: true,
      },
    });
    assert.equal(regA.status, 201);
    orgAId = regA.data.activeOrg.orgId;
    adminACookie = extractSessionCookie(regA.headers['set-cookie']);

    // Add Manager & Creator to Org A
    await requestJson(baseUrl, 'POST', `/api/orgs/${orgAId}/members`, {
      cookie: adminACookie,
      body: { name: 'Maya Mgr', email: 'maya@rag-a.test', password: 'Password!123', role: 'brand_manager' },
    });
    await requestJson(baseUrl, 'POST', `/api/orgs/${orgAId}/members`, {
      cookie: adminACookie,
      body: { name: 'Charlie Creator', email: 'charlie@rag-a.test', password: 'Password!123', role: 'creator' },
    });

    const mgrLogin = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'maya@rag-a.test', password: 'Password!123' },
    });
    managerACookie = extractSessionCookie(mgrLogin.headers['set-cookie']);

    const crLogin = await requestJson(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'charlie@rag-a.test', password: 'Password!123' },
    });
    creatorACookie = extractSessionCookie(crLogin.headers['set-cookie']);

    // Org B empty knowledge base (no seed data)
    const regB = await requestJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        name: 'Bob Empty Org',
        email: 'bob@rag-b.test',
        password: 'StrongPassword!123',
        orgName: 'Beta Empty Org',
        seedStarterBrand: false,
      },
    });
    assert.equal(regB.status, 201);
    adminBCookie = extractSessionCookie(regB.headers['set-cookie']);
  });

  after(async () => {
    await dbClose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('1. Empty Knowledge Base triggers missing-evidence warning and never fabricates citations', async () => {
    const searchRes = await requestJson(baseUrl, 'POST', '/api/rag/search', {
      cookie: adminBCookie,
      body: { query: 'enterprise uptime SLA and corporate claims' },
    });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.data.missing_evidence_warning, true);
    assert.equal(searchRes.data.items.length, 0);

    const analyzeRes = await requestJson(baseUrl, 'POST', '/api/submissions/analyze', {
      cookie: adminBCookie,
      body: {
        title: 'Unverified Launch Claim',
        content_type: 'Website Copy',
        content: 'We serve 95,000 customers globally across 140 countries.',
      },
    });
    assert.equal(analyzeRes.status, 200);
    assert.equal(analyzeRes.data.retrieval_summary.missing_evidence_warning, true);
    assert.ok(analyzeRes.data.issues.length >= 1);

    const statIssue = analyzeRes.data.issues[0];
    assert.equal(statIssue.evidence_status, 'Unverified');
    assert.equal(statIssue.source_document, 'No Indexed Source Found');
    assert.ok(Number(statIssue.confidence_score) < 50);
  });

  test('2. Document validation rejects invalid formats, empty files, and corrupted PDFs', async () => {
    const badExt = await requestJson(baseUrl, 'POST', '/api/rag/documents', {
      cookie: managerACookie,
      body: {
        fileName: 'malware.exe',
        mimeType: 'application/octet-stream',
        fileBase64: Buffer.from('MZfake').toString('base64'),
      },
    });
    assert.equal(badExt.status, 400);

    const emptyFile = await requestJson(baseUrl, 'POST', '/api/rag/documents', {
      cookie: managerACookie,
      body: {
        fileName: 'empty.txt',
        mimeType: 'text/plain',
        fileBase64: Buffer.from('   \n  ', 'utf8').toString('base64'),
      },
    });
    assert.equal(emptyFile.status, 400);

    const corruptPdf = await requestJson(baseUrl, 'POST', '/api/rag/documents', {
      cookie: managerACookie,
      body: {
        fileName: 'corrupt.pdf',
        mimeType: 'application/pdf',
        fileBase64: Buffer.from('NOT-A-VALID-PDF-HEADER-OR-XREF', 'utf8').toString('base64'),
      },
    });
    assert.equal(corruptPdf.status, 400);
  });

  test('3. Scanned textless PDF gracefully records OCR-needed status when GEMINI_API_KEY is unset', async () => {
    const scannedPdf = createBlankTextlessPdf();
    const res = await requestJson(baseUrl, 'POST', '/api/rag/documents', {
      cookie: managerACookie,
      body: {
        fileName: 'scanned-handbook.pdf',
        mimeType: 'application/pdf',
        fileBase64: scannedPdf.toString('base64'),
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.document.indexing_status, 'partial_ocr_needed');
    assert.equal(res.data.document.chunk_count, 0);
    assert.ok(Array.isArray(res.data.document.warnings) && res.data.document.warnings.length > 0);
  });

  test('4. Policy document ingestion, duplicate SHA-256 rejection (409), RBAC, and hybrid search', async () => {
    const policyText = [
      '## Corporate Identity & Heritage',
      'Alpha RAG Org was founded in 2018 in Pune and operates enterprise governance workflows.',
      'All corporate communications must state the 2018 founding year accurately.',
      '',
      '## Legal Claims & Prohibited Language',
      'Prohibited phrase: "zero-risk deployment" must never appear in external marketing materials.',
      'Security communications must cite the audited 99.99% uptime SLA verified in our SOC 2 report.',
    ].join('\n');

    const payload = {
      fileName: 'Alpha_Policy_Manual_2026.txt',
      mimeType: 'text/plain',
      fileBase64: Buffer.from(policyText, 'utf8').toString('base64'),
    };

    // Creator is forbidden (403)
    const creatorAttempt = await requestJson(baseUrl, 'POST', '/api/rag/documents', {
      cookie: creatorACookie,
      body: payload,
    });
    assert.equal(creatorAttempt.status, 403);

    // Brand Manager succeeds (201)
    const mgrIngest = await requestJson(baseUrl, 'POST', '/api/rag/documents', {
      cookie: managerACookie,
      body: payload,
    });
    assert.equal(mgrIngest.status, 201);
    assert.equal(mgrIngest.data.document.indexing_status, 'indexed');
    assert.ok(mgrIngest.data.document.chunk_count >= 1);
    ingestedTxtDocId = mgrIngest.data.document.id;

    // Duplicate upload returns 409 Conflict
    const dupIngest = await requestJson(baseUrl, 'POST', '/api/rag/documents', {
      cookie: adminACookie,
      body: payload,
    });
    assert.equal(dupIngest.status, 409);

    // Hybrid search finds exact cited section from ingested handbook
    const searchRes = await requestJson(baseUrl, 'POST', '/api/rag/search', {
      cookie: creatorACookie,
      body: { query: 'zero-risk deployment prohibited marketing claims', topK: 5 },
    });
    assert.equal(searchRes.status, 200);
    assert.ok(searchRes.data.items.length >= 1);
    const docHit = searchRes.data.items.find(
      (i: any) => i.source_type === 'document_chunk' && i.source_document === 'Alpha_Policy_Manual_2026.txt'
    );
    assert.ok(docHit, 'Expected retrieved evidence chunk from Alpha_Policy_Manual_2026.txt');
    assert.ok(docHit.excerpt.toLowerCase().includes('zero-risk deployment'));
  });

  test('5. Submission compliance scan distinguishes Contradicted vs Unverified claims with persisted citations', async () => {
    // Register an approved fact in Org A
    const factRes = await requestJson(baseUrl, 'POST', '/api/facts', {
      cookie: managerACookie,
      body: {
        fact: 'Alpha RAG Org was founded in 2018 and maintains a 99.99% uptime SLA.',
        source: 'Corporate Annual Charter 2026',
      },
    });
    assert.equal(factRes.status, 201);

    const analyzeRes = await requestJson(baseUrl, 'POST', '/api/submissions/analyze', {
      cookie: creatorACookie,
      body: {
        title: 'Partner Press Release',
        content_type: 'Press Release',
        content:
          'Founded in 2021, our platform delivers zero-risk deployment to 75,000 customers worldwide.',
      },
    });
    assert.equal(analyzeRes.status, 200);

    const issues = analyzeRes.data.issues as any[];
    assert.ok(issues.length >= 3, `Expected at least 3 findings, got ${issues.length}`);

    const contradictedYear = issues.find((i) => i.title.includes('Contradicted Founding Year'));
    assert.ok(contradictedYear, 'Expected Contradicted Founding Year issue');
    assert.equal(contradictedYear.evidence_status, 'Contradicted');
    assert.ok(contradictedYear.confidence_score >= 85);

    const docRuleHit = issues.find((i) => i.source_document === 'Alpha_Policy_Manual_2026.txt');
    assert.ok(docRuleHit, 'Expected indexed RAG document citation');
    assert.equal(docRuleHit.evidence_status, 'Contradicted');
    assert.ok(docRuleHit.supporting_guideline_excerpt.toLowerCase().includes('zero-risk deployment'));

    const unverifiedStat = issues.find((i) => i.problematic_text.includes('75,000 customers'));
    assert.ok(unverifiedStat, 'Expected Unverified statistical claim issue');
    assert.equal(unverifiedStat.evidence_status, 'Unverified');
    assert.equal(unverifiedStat.source_document, 'No Indexed Source Found');

    // Verify citations persist on reload
    const detailRes = await requestJson(baseUrl, 'GET', `/api/submissions/${analyzeRes.data.submission.id}`, {
      cookie: managerACookie,
    });
    assert.equal(detailRes.status, 200);
    assert.ok(
      detailRes.data.issues.some(
        (i: any) => i.source_document === 'Alpha_Policy_Manual_2026.txt' && i.evidence_status === 'Contradicted'
      )
    );
  });

  test('6. Cross-organisation RAG isolation prevents searching or deleting Org A documents from Org B', async () => {
    const orgBSearch = await requestJson(baseUrl, 'POST', '/api/rag/search', {
      cookie: adminBCookie,
      body: { query: 'zero-risk deployment Alpha_Policy_Manual_2026' },
    });
    assert.equal(orgBSearch.status, 200);
    assert.equal(orgBSearch.data.searched_chunks, 0);
    assert.equal(orgBSearch.data.items.length, 0);

    const orgBDocs = await requestJson(baseUrl, 'GET', '/api/rag/documents', { cookie: adminBCookie });
    assert.equal(orgBDocs.status, 200);
    assert.equal(orgBDocs.data.documents.length, 0);

    const orgBDelete = await requestJson(baseUrl, 'DELETE', `/api/rag/documents/${ingestedTxtDocId}`, {
      cookie: adminBCookie,
    });
    assert.equal(orgBDelete.status, 404);

    // Creator in Org A cannot delete, Brand Manager in Org A can delete
    const crDelete = await requestJson(baseUrl, 'DELETE', `/api/rag/documents/${ingestedTxtDocId}`, {
      cookie: creatorACookie,
    });
    assert.equal(crDelete.status, 403);

    const mgrDelete = await requestJson(baseUrl, 'DELETE', `/api/rag/documents/${ingestedTxtDocId}`, {
      cookie: managerACookie,
    });
    assert.equal(mgrDelete.status, 200);
  });
}
