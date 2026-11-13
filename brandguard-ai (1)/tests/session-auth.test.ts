import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

function getSetCookie(headers: Headers): string {
  const sc = headers.get('set-cookie');
  assert.ok(sc, 'Expected Set-Cookie header');
  return sc;
}

function getCookiePair(setCookie: string): string {
  const pair = setCookie.split(';')[0].trim();
  assert.ok(pair.startsWith('bg_session='), `Expected bg_session cookie pair, got: ${pair}`);
  return pair;
}

test('End-to-end session persistence, cookie policies (HTTP / HTTPS / cross-site iframe), CORS, rotation, expiry, and restart survival', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-session-auth-'));
  const dbPath = path.join(tmpDir, 'session-auth.db');
  const prevCors = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = 'https://frontend.brandguard.test';

  let cookieA = '';
  let orgAId = '';

  // Boot 1: register, sign in, verify DB session, cookie attributes, CORS, and rotation
  const boot1 = await createApp({ dbPath });
  const server1 = boot1.app.listen(0);
  try {
    const baseUrl = `http://127.0.0.1:${(server1.address() as AddressInfo).port}`;

    // 0. Initial unauthenticated bootstrap check via /api/auth/session returns 200 { authenticated: false }
    //    while strict /api/auth/me returns 401
    const unauthSessionProbe = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(unauthSessionProbe.status, 200);
    const unauthSessionBody = (await unauthSessionProbe.json()) as any;
    assert.equal(unauthSessionBody.authenticated, false);
    assert.equal(unauthSessionBody.user, null);

    const unauthMe = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(unauthMe.status, 401);

    // 1. Register new workspace over local HTTP -> SameSite=Lax, HttpOnly, Path=/, Max-Age=86400, no Secure
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Elena Admin',
        email: 'elena@session.test',
        password: 'StrongPassword!123',
        orgName: 'Session Test Org',
        seedStarterBrand: true,
      }),
    });
    assert.equal(regRes.status, 201);
    const regCookieHeader = getSetCookie(regRes.headers);
    assert.match(regCookieHeader, /HttpOnly/i);
    assert.match(regCookieHeader, /Path=\//i);
    assert.match(regCookieHeader, /SameSite=Lax/i);
    assert.match(regCookieHeader, /Max-Age=86400/i);
    assert.doesNotMatch(regCookieHeader, /;\s*Secure/i);
    cookieA = getCookiePair(regCookieHeader);
    const regBody = (await regRes.json()) as any;
    orgAId = regBody.activeOrg.orgId;

    // 2. Verify session exists in DB with future expires_at and non-revoked status
    const sessionsAfterReg = await boot1.db.query<any>(
      'SELECT id, expires_at, revoked_at FROM sessions WHERE user_id = $1',
      [regBody.user.id]
    );
    assert.equal(sessionsAfterReg.rows.length, 1);
    assert.equal(sessionsAfterReg.rows[0].revoked_at, null);
    assert.ok(new Date(sessionsAfterReg.rows[0].expires_at).getTime() > Date.now() + 3600_000);

    // 3. Repeated login carrying the existing browser cookie rotates cleanly (only 1 active session)
    const loginAgain = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ email: 'elena@session.test', password: 'StrongPassword!123' }),
    });
    assert.equal(loginAgain.status, 200);
    cookieA = getCookiePair(getSetCookie(loginAgain.headers));

    const activeSessions = await boot1.db.query<any>(
      'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [regBody.user.id]
    );
    assert.equal(activeSessions.rows.length, 1, 'Expected session rotation to prevent duplicate active sessions');

    // 4. Open dashboard API routes + authenticated /api/auth/session probe
    const authSessionProbe = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookieA } });
    assert.equal(authSessionProbe.status, 200);
    const authSessionBody = (await authSessionProbe.json()) as any;
    assert.equal(authSessionBody.authenticated, true);
    assert.equal(authSessionBody.user.email, 'elena@session.test');

    for (const route of ['/api/auth/me', '/api/guidelines', '/api/facts', '/api/submissions', '/api/analytics']) {
      const r = await fetch(`${baseUrl}${route}`, { headers: { Cookie: cookieA } });
      assert.equal(r.status, 200, `Expected 200 on ${route}`);
    }

    // 5. Same-site HTTPS reverse proxy (X-Forwarded-Proto: https, same-origin) -> SameSite=Lax; Secure
    const httpsSameSiteLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'X-Client-Context': 'same-origin',
      },
      body: JSON.stringify({ email: 'elena@session.test', password: 'StrongPassword!123' }),
    });
    assert.equal(httpsSameSiteLogin.status, 200);
    const sameSiteSetCookie = getSetCookie(httpsSameSiteLogin.headers);
    assert.match(sameSiteSetCookie, /SameSite=Lax/i);
    assert.match(sameSiteSetCookie, /Secure/i);
    assert.doesNotMatch(sameSiteSetCookie, /Partitioned/i);

    // 6. Cross-site HTTPS iframe (AI Studio preview: X-Forwarded-Proto: https + X-Client-Context: iframe)
    //    -> SameSite=None; Secure; Partitioned
    const iframeLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'X-Client-Context': 'iframe',
      },
      body: JSON.stringify({ email: 'elena@session.test', password: 'StrongPassword!123' }),
    });
    assert.equal(iframeLogin.status, 200);
    const iframeSetCookie = getSetCookie(iframeLogin.headers);
    assert.match(iframeSetCookie, /SameSite=None/i);
    assert.match(iframeSetCookie, /Secure/i);
    assert.match(iframeSetCookie, /Partitioned/i);
    cookieA = getCookiePair(iframeSetCookie);

    // Logout from iframe context emits matching SameSite=None; Secure; Partitioned; Max-Age=0
    const tempLogout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: cookieA,
        'X-Forwarded-Proto': 'https',
        'X-Client-Context': 'iframe',
      },
    });
    assert.equal(tempLogout.status, 200);
    const clearHeader = getSetCookie(tempLogout.headers);
    assert.match(clearHeader, /Max-Age=0/i);
    assert.match(clearHeader, /SameSite=None/i);
    assert.match(clearHeader, /Partitioned/i);

    // 6b. Real Cloud Run + Nginx proxy behavior:
    // Nginx listens on 8080 HTTP and rewrites Host -> localhost:3000 & X-Forwarded-Proto -> http,
    // while forwarding external host in X-Forwarded-Host and keeping browser HTTPS Origin.
    const nginxIframeLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Host': 'ais-dev-preview.run.app',
        Origin: 'https://ais-dev-preview.run.app',
        'X-Client-Context': 'iframe',
        'X-Client-Protocol': 'https:',
      },
      body: JSON.stringify({ email: 'elena@session.test', password: 'StrongPassword!123' }),
    });
    assert.equal(nginxIframeLogin.status, 200);
    const nginxIframeSetCookie = getSetCookie(nginxIframeLogin.headers);
    assert.match(nginxIframeSetCookie, /SameSite=None/i);
    assert.match(nginxIframeSetCookie, /Secure/i);
    assert.match(nginxIframeSetCookie, /Partitioned/i);

    // Standalone HTTPS tab behind Nginx -> X-Forwarded-Host matches Origin -> SameSite=Lax; Secure (no Partitioned)
    const nginxStandaloneLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Host': 'ais-pre-standalone.run.app',
        Origin: 'https://ais-pre-standalone.run.app',
        'X-Client-Context': 'same-origin',
        'X-Client-Protocol': 'https:',
      },
      body: JSON.stringify({ email: 'elena@session.test', password: 'StrongPassword!123' }),
    });
    assert.equal(nginxStandaloneLogin.status, 200);
    const nginxStandaloneSetCookie = getSetCookie(nginxStandaloneLogin.headers);
    assert.match(nginxStandaloneSetCookie, /SameSite=Lax/i);
    assert.match(nginxStandaloneSetCookie, /Secure/i);
    assert.doesNotMatch(nginxStandaloneSetCookie, /Partitioned/i);

    // Plain HTTP localhost with explicit http: protocol -> SameSite=Lax without Secure
    const localHttpLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        Origin: 'http://localhost:3000',
        'X-Client-Context': 'same-origin',
        'X-Client-Protocol': 'http:',
      },
      body: JSON.stringify({ email: 'elena@session.test', password: 'StrongPassword!123' }),
    });
    assert.equal(localHttpLogin.status, 200);
    const localHttpSetCookie = getSetCookie(localHttpLogin.headers);
    assert.match(localHttpSetCookie, /SameSite=Lax/i);
    assert.doesNotMatch(localHttpSetCookie, /;\s*Secure/i);

    // Log back in cleanly for restart test
    const freshLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'elena@session.test', password: 'StrongPassword!123' }),
    });
    assert.equal(freshLogin.status, 200);
    cookieA = getCookiePair(getSetCookie(freshLogin.headers));

    // 7. Strict credentialed CORS checks (permitted exact origin, X-Forwarded-Host self-origin, vs rejected origin)
    const allowedPreflight = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://frontend.brandguard.test' },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), 'https://frontend.brandguard.test');
    assert.equal(allowedPreflight.headers.get('access-control-allow-credentials'), 'true');
    assert.notEqual(allowedPreflight.headers.get('access-control-allow-origin'), '*');

    const forwardedHostPreflight = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Host: 'localhost:3000',
        'X-Forwarded-Host': 'ais-pre-standalone.run.app',
        Origin: 'https://ais-pre-standalone.run.app',
      },
    });
    assert.equal(forwardedHostPreflight.status, 204);
    assert.equal(
      forwardedHostPreflight.headers.get('access-control-allow-origin'),
      'https://ais-pre-standalone.run.app'
    );
    assert.equal(forwardedHostPreflight.headers.get('access-control-allow-credentials'), 'true');

    const deniedPreflight = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil-site.example' },
    });
    assert.equal(deniedPreflight.status, 403);
    assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);

    // 8. Malformed cookie encoding never throws 500
    const malformedRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: 'bg_session=%E0%A4%A' },
    });
    assert.equal(malformedRes.status, 401);

    // 9. Manually expired session row in DB returns 401 cleanly
    await boot1.db.query(
      `INSERT INTO sessions (id, user_id, active_org_id, token_hash, expires_at, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
      [
        'SES-EXPIRED-CHECK',
        regBody.user.id,
        orgAId,
        '0000000000000000000000000000000000000000000000000000000000000000',
        new Date(Date.now() - 60_000).toISOString(),
        new Date().toISOString(),
      ]
    );
  } finally {
    await boot1.db.close();
    await new Promise<void>((resolve) => server1.close(() => resolve()));
  }

  // Boot 2: Simulates server restart + browser reopen (same DB + persistent dev session secret)
  const boot2 = await createApp({ dbPath });
  const server2 = boot2.app.listen(0);
  try {
    const baseUrl2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;

    // Session MUST remain valid across restart!
    const meAfterRestart = await fetch(`${baseUrl2}/api/auth/me`, {
      headers: { Cookie: cookieA },
    });
    assert.equal(meAfterRestart.status, 200, 'Session should survive dev server restart');

    // Sign out revokes session and blocks subsequent protected requests
    const logoutRes = await fetch(`${baseUrl2}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookieA },
    });
    assert.equal(logoutRes.status, 200);

    const afterLogoutMe = await fetch(`${baseUrl2}/api/auth/me`, { headers: { Cookie: cookieA } });
    assert.equal(afterLogoutMe.status, 401);
    const afterLogoutGuidelines = await fetch(`${baseUrl2}/api/guidelines`, { headers: { Cookie: cookieA } });
    assert.equal(afterLogoutGuidelines.status, 401);

    // Incorrect password rejected with 401; valid sign-in succeeds again
    const wrongPass = await fetch(`${baseUrl2}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'elena@session.test', password: 'WrongPassword!123' }),
    });
    assert.equal(wrongPass.status, 401);

    const relogin = await fetch(`${baseUrl2}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'elena@session.test', password: 'StrongPassword!123' }),
    });
    assert.equal(relogin.status, 200);
    const cookieA2 = getCookiePair(getSetCookie(relogin.headers));
    const meReauthed = await fetch(`${baseUrl2}/api/auth/me`, { headers: { Cookie: cookieA2 } });
    assert.equal(meReauthed.status, 200);
  } finally {
    await boot2.db.close();
    await new Promise<void>((resolve) => server2.close(() => resolve()));
    if (prevCors === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = prevCors;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
