import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { DbAdapter } from '../db/types.js';
import { ConfigurationError } from '../errors.js';

export const SESSION_COOKIE_NAME = 'bg_session';

const DEV_SECRET_FILE = path.resolve(process.cwd(), 'data', '.dev-session-secret');
let cachedDevSecret: string | null = null;

export function getSessionSecret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured && configured.length >= 16) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new ConfigurationError(
      'SESSION_SECRET (at least 16 characters; 32+ recommended) must be configured in production.'
    );
  }

  if (cachedDevSecret) {
    return cachedDevSecret;
  }

  try {
    if (fs.existsSync(DEV_SECRET_FILE)) {
      const stored = fs.readFileSync(DEV_SECRET_FILE, 'utf8').trim();
      if (stored.length >= 32) {
        cachedDevSecret = stored;
        return cachedDevSecret;
      }
    }
    const dir = path.dirname(DEV_SECRET_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(DEV_SECRET_FILE, `${generated}\n`, { mode: 0o600 });
    cachedDevSecret = generated;
    return cachedDevSecret;
  } catch {
    cachedDevSecret = crypto.randomBytes(32).toString('hex');
    return cachedDevSecret;
  }
}

export function getSessionTtlMs(): number {
  const raw = (process.env.SESSION_TTL_HOURS || '').trim();
  const hours = raw ? Number(raw) : 24;
  const validHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  return validHours * 60 * 60 * 1000;
}

export function logAuthDiagnostic(event: string, details: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === 'test' && process.env.AUTH_DEBUG_LOGS !== 'true') {
    return;
  }
  const safePayload = Object.fromEntries(
    Object.entries(details).filter(
      ([k]) =>
        !/password|secret|token|cookie|hash|key/i.test(k)
    )
  );
  console.info(`[AUTH] ${event}`, JSON.stringify(safePayload));
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.startsWith('scrypt$')) {
    return false;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, originalHex] = parts;
  if (!salt || !originalHex) return false;

  try {
    const derivedBuf = crypto.scryptSync(password, salt, 64);
    const originalBuf = Buffer.from(originalHex, 'hex');
    if (derivedBuf.length !== originalBuf.length) return false;
    return crypto.timingSafeEqual(derivedBuf, originalBuf);
  } catch {
    return false;
  }
}

export function hashSessionToken(rawToken: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(rawToken).digest('hex');
}

export interface SessionCreationResult {
  sessionId: string;
  rawToken: string;
  expiresAt: string;
}

export async function createSession(
  db: DbAdapter,
  userId: string,
  activeOrgId: string,
  meta?: { ipAddress?: string; userAgent?: string }
): Promise<SessionCreationResult> {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(rawToken);
  const sessionId = `SES-${crypto.randomUUID()}`;
  const nowMs = Date.now();
  const ttlMs = getSessionTtlMs();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();

  await db.query(
    `INSERT INTO sessions (id, user_id, active_org_id, token_hash, expires_at, revoked_at, ip_address, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
    [
      sessionId,
      userId,
      activeOrgId,
      tokenHash,
      expiresAt,
      meta?.ipAddress || null,
      meta?.userAgent || null,
      new Date(nowMs).toISOString(),
    ]
  );

  // Confirm persistence before returning success to caller
  const persisted = await db.queryOne<{ id: string }>(
    'SELECT id FROM sessions WHERE id = $1 AND token_hash = $2',
    [sessionId, tokenHash]
  );
  if (!persisted) {
    logAuthDiagnostic('session_persist_failed', { sessionId, userId, activeOrgId });
    throw new Error('Failed to verify persisted session record.');
  }

  logAuthDiagnostic('session_created', {
    sessionId,
    userId,
    activeOrgId,
    expiresAt,
    ttlSeconds: Math.floor(ttlMs / 1000),
  });

  return { sessionId, rawToken, expiresAt };
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  activeOrgId: string;
  expiresAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
    is_active: number;
  };
}

export type SessionLookupFailureReason =
  | 'invalid_format'
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'inactive_user';

export interface SessionLookupResult {
  session: AuthenticatedSession | null;
  reason?: SessionLookupFailureReason;
}

export async function resolveSessionDetailed(
  db: DbAdapter,
  rawToken: string
): Promise<SessionLookupResult> {
  if (!rawToken || rawToken.length < 16) {
    return { session: null, reason: 'invalid_format' };
  }
  const tokenHash = hashSessionToken(rawToken);

  const row = await db.queryOne<any>(
    `SELECT s.id as session_id, s.user_id, s.active_org_id, s.expires_at, s.revoked_at,
            u.id as u_id, u.name as u_name, u.email as u_email, u.avatar as u_avatar, u.is_active as u_is_active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash]
  );

  if (!row) {
    return { session: null, reason: 'not_found' };
  }
  if (row.revoked_at) {
    return { session: null, reason: 'revoked' };
  }

  const expiresMs = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return { session: null, reason: 'expired' };
  }
  if (!row.u_is_active) {
    return { session: null, reason: 'inactive_user' };
  }

  return {
    session: {
      sessionId: row.session_id,
      userId: row.user_id,
      activeOrgId: row.active_org_id,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
      user: {
        id: row.u_id,
        name: row.u_name,
        email: row.u_email,
        avatar: row.u_avatar,
        is_active: Number(row.u_is_active),
      },
    },
  };
}

export async function resolveSession(db: DbAdapter, rawToken: string): Promise<AuthenticatedSession | null> {
  const result = await resolveSessionDetailed(db, rawToken);
  return result.session;
}

export async function revokeSession(db: DbAdapter, rawToken: string): Promise<boolean> {
  if (!rawToken) return false;
  const tokenHash = hashSessionToken(rawToken);
  const nowIso = new Date().toISOString();
  const res = await db.query(
    'UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL',
    [nowIso, tokenHash]
  );
  return res.rowCount > 0;
}

export function parseCookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    if (key === cookieName) {
      const rawVal = part.slice(eqIndex + 1).trim();
      try {
        return decodeURIComponent(rawVal);
      } catch {
        return rawVal;
      }
    }
  }
  return null;
}

export interface CookiePolicy {
  sameSite: 'Lax' | 'Strict' | 'None';
  secure: boolean;
  partitioned: boolean;
  context: 'http_same_site' | 'https_same_site' | 'https_cross_site_or_iframe';
}

export function isRequestHttps(req: Request): boolean {
  if (req.secure) return true;

  const proto = (req.header('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https') return true;

  const forwardedSsl = (req.header('x-forwarded-ssl') || req.header('front-end-https') || '').trim().toLowerCase();
  if (forwardedSsl === 'on') return true;

  // Behind local reverse proxies (e.g. Nginx listening on port 8080 inside Cloud Run),
  // X-Forwarded-Proto may be overwritten with the inner hop scheme ("http") even when
  // the browser arrived over HTTPS. Browser-supplied Origin/Referer and X-Client-Protocol
  // preserve the actual external HTTPS scheme.
  const origin = (req.header('origin') || '').trim().toLowerCase();
  if (origin.startsWith('https://')) return true;

  const referer = (req.header('referer') || '').trim().toLowerCase();
  if (referer.startsWith('https://')) return true;

  const clientProtocol = (req.header('x-client-protocol') || '').trim().toLowerCase();
  if (clientProtocol === 'https:') return true;

  const appUrl = (process.env.APP_URL || '').trim();
  const forwardedHost = (req.header('x-forwarded-host') || '').split(',')[0].trim().toLowerCase();
  if (appUrl.toLowerCase().startsWith('https://') && forwardedHost) {
    try {
      if (new URL(appUrl).host.toLowerCase() === forwardedHost) {
        return true;
      }
    } catch {
      // Ignore malformed APP_URL
    }
  }

  return false;
}

export function resolveCookiePolicy(req: Request): CookiePolicy {
  const isHttps = isRequestHttps(req);
  const envSameSite = (process.env.COOKIE_SAMESITE || '').trim().toLowerCase();

  if (!isHttps) {
    // Plain HTTP (e.g., localhost dev): browsers reject SameSite=None without Secure.
    return {
      sameSite: 'Lax',
      secure: false,
      partitioned: false,
      context: 'http_same_site',
    };
  }

  if (envSameSite === 'strict') {
    return {
      sameSite: 'Strict',
      secure: true,
      partitioned: false,
      context: 'https_same_site',
    };
  }
  if (envSameSite === 'lax') {
    return {
      sameSite: 'Lax',
      secure: true,
      partitioned: false,
      context: 'https_same_site',
    };
  }

  const secFetchSite = (req.header('sec-fetch-site') || '').trim().toLowerCase();
  const secFetchDest = (req.header('sec-fetch-dest') || '').trim().toLowerCase();
  const clientContext = (req.header('x-client-context') || '').trim().toLowerCase();
  const originHeader = (req.header('origin') || '').trim();
  const forwardedHost = (req.header('x-forwarded-host') || '').split(',')[0].trim();
  const effectiveHost = forwardedHost || (req.get('host') || '').trim();

  let originMismatch = false;
  if (originHeader && effectiveHost) {
    try {
      const parsedOrigin = new URL(originHeader);
      originMismatch = parsedOrigin.host.toLowerCase() !== effectiveHost.toLowerCase();
    } catch {
      originMismatch = false;
    }
  }

  const isCrossSiteOrEmbedded =
    envSameSite === 'none' ||
    secFetchSite === 'cross-site' ||
    secFetchDest === 'iframe' ||
    clientContext === 'iframe' ||
    clientContext === 'cross-origin' ||
    originMismatch;

  if (isCrossSiteOrEmbedded) {
    // Cross-site iframe (e.g. AI Studio) or cross-origin HTTPS API:
    // SameSite=None; Secure; Partitioned allows cookie storage per top-level site.
    return {
      sameSite: 'None',
      secure: true,
      partitioned: true,
      context: 'https_cross_site_or_iframe',
    };
  }

  return {
    sameSite: 'Lax',
    secure: true,
    partitioned: false,
    context: 'https_same_site',
  };
}

export function buildSessionCookieHeader(
  rawToken: string,
  policyOrIsHttps: boolean | CookiePolicy,
  expiresAtIso?: string
): string {
  const policy: CookiePolicy =
    typeof policyOrIsHttps === 'boolean'
      ? {
          sameSite: 'Lax',
          secure: policyOrIsHttps,
          partitioned: false,
          context: policyOrIsHttps ? 'https_same_site' : 'http_same_site',
        }
      : policyOrIsHttps;

  const ttlMs = getSessionTtlMs();
  const maxAgeSec = Math.max(60, Math.floor(ttlMs / 1000));
  const expiresDate = expiresAtIso ? new Date(expiresAtIso) : new Date(Date.now() + ttlMs);

  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${policy.sameSite}`,
    `Max-Age=${maxAgeSec}`,
    `Expires=${expiresDate.toUTCString()}`,
  ];
  if (policy.secure) {
    parts.push('Secure');
  }
  if (policy.partitioned && policy.secure && policy.sameSite === 'None') {
    parts.push('Partitioned');
  }
  return parts.join('; ');
}

export function buildClearSessionCookieHeader(policyOrIsHttps: boolean | CookiePolicy): string {
  const policy: CookiePolicy =
    typeof policyOrIsHttps === 'boolean'
      ? {
          sameSite: 'Lax',
          secure: policyOrIsHttps,
          partitioned: false,
          context: policyOrIsHttps ? 'https_same_site' : 'http_same_site',
        }
      : policyOrIsHttps;

  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${policy.sameSite}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (policy.secure) {
    parts.push('Secure');
  }
  if (policy.partitioned && policy.secure && policy.sameSite === 'None') {
    parts.push('Partitioned');
  }
  return parts.join('; ');
}
