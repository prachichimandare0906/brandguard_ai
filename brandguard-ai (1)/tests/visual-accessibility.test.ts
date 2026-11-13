import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import sharp from 'sharp';
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

async function createGeometricBrandLogoPng(): Promise<Buffer> {
  // 128x128 navy (#0F172A) background with sharp geometric teal (#0D9488) and slate (#F8FAFC) bands
  const tealTile = await sharp({
    create: { width: 56, height: 56, channels: 3, background: { r: 13, g: 148, b: 136 } },
  })
    .png()
    .toBuffer();

  const whiteBar = await sharp({
    create: { width: 88, height: 18, channels: 3, background: { r: 248, g: 250, b: 252 } },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 15, g: 23, b: 42 } },
  })
    .composite([
      { input: tealTile, top: 20, left: 36 },
      { input: whiteBar, top: 90, left: 20 },
    ])
    .png()
    .toBuffer();
}

async function createOffBrandMagentaPng(): Promise<Buffer> {
  // 128x128 off-brand neon magenta (#FF00FF) with bright lime (#00FF00) bottom band
  const limeBand = await sharp({
    create: { width: 128, height: 48, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 255, g: 0, b: 255 } },
  })
    .composite([{ input: limeBand, top: 80, left: 0 }])
    .png()
    .toBuffer();
}

describeVisualAccessibilitySuite();

function describeVisualAccessibilitySuite() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-visual-test-'));
  const testDbPath = path.join(tmpDir, 'visual-test.db');

  let server: http.Server;
  let baseUrl: string;
  let dbClose: () => Promise<void>;

  let adminACookie = '';
  let adminBCookie = '';
  let refLogoAssetId = '';
  let offBrandAnalysisId = '';

  before(async () => {
    delete process.env.GEMINI_API_KEY;
    const { app, db } = await createApp({ dbPath: testDbPath });
    dbClose = () => db.close();
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const regA = await requestJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        name: 'Alice Visual Admin',
        email: 'alice@visual-a.test',
        password: 'StrongPassword!123',
        orgName: 'Alpha Visual Org',
        seedStarterBrand: true,
      },
    });
    assert.equal(regA.status, 201);
    adminACookie = extractSessionCookie(regA.headers['set-cookie']);

    const regB = await requestJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        name: 'Bob Rival Visual',
        email: 'bob@visual-b.test',
        password: 'StrongPassword!123',
        orgName: 'Beta Visual Org',
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

  test('1. Perceptual logo comparison scores matching logo highly and detects dimensions + raster limitations', async () => {
    const logoPng = await createGeometricBrandLogoPng();

    // Register reference logo asset in Org A
    const assetRes = await requestJson(baseUrl, 'POST', '/api/assets', {
      cookie: adminACookie,
      body: {
        asset_name: 'Primary BrandGuard Mark',
        asset_type: 'Logo',
        guidelines: 'Use approved navy, teal, and slate geometric emblem.',
        fileName: 'primary-mark.png',
        mimeType: 'image/png',
        fileBase64: logoPng.toString('base64'),
      },
    });
    assert.equal(assetRes.status, 201);
    refLogoAssetId = assetRes.data.id;

    const analyzeRes = await requestJson(baseUrl, 'POST', '/api/visual/analyze', {
      cookie: adminACookie,
      body: {
        fileName: 'hero-logo-banner.png',
        mimeType: 'image/png',
        fileBase64: logoPng.toString('base64'),
        altText: 'Alpha Visual Org primary corporate logo emblem in navy and teal',
        foregroundHex: '#0F172A',
        backgroundHex: '#FFFFFF',
      },
    });
    assert.equal(analyzeRes.status, 201);
    const analysis = analyzeRes.data.analysis;

    assert.equal(analysis.matched_logo_asset_id, refLogoAssetId);
    assert.ok(
      Number(analysis.logo_similarity_score) >= 85,
      `Expected high logo similarity score >= 85, got ${analysis.logo_similarity_score}`
    );
    assert.equal(analysis.dimensions.width, 128);
    assert.equal(analysis.dimensions.height, 128);
    assert.ok(analysis.limitations.length > 0, 'Expected honest flattened-raster font limitation notice');

    // WCAG #0F172A on #FFFFFF should easily pass AAA/AA (~17.85:1)
    assert.ok(analysis.wcag_results.length >= 1);
    assert.equal(analysis.wcag_results[0].aaNormalPass, true);
    assert.ok(analysis.wcag_results[0].contrastRatio >= 15);
  });

  test('2. Off-brand colour deviation, low WCAG 2.1 contrast suggestion, and missing alt-text audit + inline fix', async () => {
    const offBrandPng = await createOffBrandMagentaPng();

    const analyzeRes = await requestJson(baseUrl, 'POST', '/api/visual/analyze', {
      cookie: adminACookie,
      body: {
        fileName: 'offbrand-promo.png',
        mimeType: 'image/png',
        fileBase64: offBrandPng.toString('base64'),
        altText: '',
        foregroundHex: '#777777',
        backgroundHex: '#999999',
      },
    });
    assert.equal(analyzeRes.status, 201);
    const analysis = analyzeRes.data.analysis;
    offBrandAnalysisId = analysis.id;

    // Logo similarity against geometric navy/teal logo should be substantially lower than match
    assert.ok(
      Number(analysis.logo_similarity_score) < 75,
      `Expected low logo similarity for magenta/lime graphic, got ${analysis.logo_similarity_score}`
    );

    // Off-brand HEX colors detected with Delta-E > 28
    assert.ok(
      analysis.extracted_colors.some((c: any) => !c.isOnBrand && c.deltaE > 28),
      'Expected off-brand color Delta-E violation'
    );
    assert.ok(analysis.findings.some((f: any) => f.category === 'Brand Color'));

    // Exact WCAG 2.1 contrast calculation (#777777 on #999999 ~ 1.61:1)
    const wcag = analysis.wcag_results[0];
    assert.ok(wcag.contrastRatio >= 1.5 && wcag.contrastRatio <= 1.75, `Got ${wcag.contrastRatio}`);
    assert.equal(wcag.aaNormalPass, false);
    assert.equal(wcag.aaLargePass, false);
    assert.ok(wcag.suggestedForegroundHex, 'Expected accessible replacement HEX suggestion');
    assert.ok(wcag.suggestedContrastRatio >= 4.5, 'Expected suggested HEX to pass >= 4.5:1');
    assert.ok(analysis.findings.some((f: any) => f.category === 'WCAG Contrast'));

    // Missing alt-text High severity finding
    const altFinding = analysis.findings.find((f: any) => f.category === 'Accessibility');
    assert.ok(altFinding, 'Expected Accessibility missing alt-text finding');
    assert.equal(altFinding.severity, 'High');
    const scoreBeforeFix = analysis.overall_score;

    // Inline alt-text remediation clears Accessibility finding & boosts score
    const patchRes = await requestJson(baseUrl, 'PATCH', `/api/visual/analyses/${offBrandAnalysisId}/alt-text`, {
      cookie: adminACookie,
      body: { altText: 'Promotional product banner highlighting quarterly compliance release' },
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.data.findings.some((f: any) => f.category === 'Accessibility'), false);
    assert.ok(patchRes.data.overall_score > scoreBeforeFix);
  });

  test('3. SVG/CSS markup verifies approved vs unapproved font families and embedded color pairs', async () => {
    const svgMarkup = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100">',
      '  <rect width="320" height="100" fill="#0F172A" />',
      '  <text x="16" y="55" fill="#FFFFFF" style="font-family: Comic Sans MS, sans-serif">Legacy Banner</text>',
      '</svg>',
    ].join('\n');

    const res = await requestJson(baseUrl, 'POST', '/api/visual/analyze', {
      cookie: adminACookie,
      body: {
        fileName: 'legacy-hero.svg',
        mimeType: 'image/svg+xml',
        fileBase64: Buffer.from(svgMarkup, 'utf8').toString('base64'),
        altText: 'Legacy hero SVG graphic showing brand headline',
        htmlOrCss: svgMarkup,
      },
    });
    assert.equal(res.status, 201);
    const analysis = res.data.analysis;

    const comicFont = analysis.detected_fonts.find((f: any) => f.family.toLowerCase().includes('comic sans'));
    assert.ok(comicFont, 'Expected Comic Sans MS extracted from SVG style');
    assert.equal(comicFont.approved, false);
    assert.ok(analysis.findings.some((f: any) => f.category === 'Typography'));
  });

  test('4. Cross-organisation visual governance isolation prevents Org B reading or patching Org A analyses', async () => {
    const listB = await requestJson(baseUrl, 'GET', '/api/visual/analyses', { cookie: adminBCookie });
    assert.equal(listB.status, 200);
    assert.equal(listB.data.analyses.length, 0);

    const patchB = await requestJson(baseUrl, 'PATCH', `/api/visual/analyses/${offBrandAnalysisId}/alt-text`, {
      cookie: adminBCookie,
      body: { altText: 'Cross tenant hijack attempt' },
    });
    assert.equal(patchB.status, 404);
  });
}
