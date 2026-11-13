import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createDatabaseAdapter, DbAdapter, seedStarterWorkspaceForOrg } from './db/index.js';
import { analyzeWithGemini, AnalysisResult } from './gemini.js';
import { analyzeWithRuleEngine } from './ruleFallback.js';
import { DocumentValidationError, extractTextFromFile } from './documentParser.js';
import {
  DuplicateDocumentError,
  ingestOrgDocument,
  retrieveOrgEvidence,
} from './services/ragService.js';
import {
  VisualValidationError,
  normalizeHex,
  runVisualGovernanceAnalysis,
} from './services/visualGovernanceService.js';
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  createSession,
  getSessionSecret,
  hashPassword,
  isRequestHttps,
  logAuthDiagnostic,
  resolveCookiePolicy,
  resolveSession,
  revokeSession,
  verifyPassword,
} from './services/authService.js';
import { recordAuditLog } from './services/auditLogger.js';
import { AuthRequest, createAuthMiddleware, extractRawToken, OrgRole } from './middleware/authMiddleware.js';
import { ObjectStorageService } from './services/objectStorage.js';
import { ConfigurationError, DatabaseUnavailableError, StorageUnavailableError } from './errors.js';

export interface CreateAppOptions {
  databaseUrl?: string;
  dbPath?: string;
  dbAdapter?: DbAdapter;
  storageService?: ObjectStorageService;
  runMigrations?: boolean;
}

function getAllowedCorsOrigins(): Set<string> {
  const allowed = new Set<string>();
  const raw = [process.env.CORS_ORIGINS, process.env.FRONTEND_ORIGIN, process.env.APP_URL]
    .filter(Boolean)
    .join(',');
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '*') continue;
    try {
      allowed.add(new URL(trimmed).origin.toLowerCase());
    } catch {
      // Ignore malformed origin entries
    }
  }
  return allowed;
}

function isOriginPermitted(req: Request, origin: string, configuredOrigins: Set<string>): boolean {
  let normalizedOrigin = '';
  try {
    normalizedOrigin = new URL(origin).origin.toLowerCase();
  } catch {
    return false;
  }

  const forwardedHost = (req.header('x-forwarded-host') || '').split(',')[0].trim().toLowerCase();
  const host = (req.get('host') || '').trim().toLowerCase();
  for (const candidateHost of [forwardedHost, host]) {
    if (!candidateHost) continue;
    if (normalizedOrigin === `https://${candidateHost}` || normalizedOrigin === `http://${candidateHost}`) {
      return true;
    }
  }
  return configuredOrigins.has(normalizedOrigin);
}

function slugifyOrgName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'workspace';
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const asyncHandler =
  (fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<any>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export async function createApp(options: CreateAppOptions = {}) {
  // Ensure session secret rules are validated at startup (strict in production)
  getSessionSecret();

  const storage = options.storageService ?? new ObjectStorageService();
  if (process.env.NODE_ENV === 'production' && !storage.isConfigured()) {
    throw new ConfigurationError(
      'S3-compatible object storage (OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_REGION, OBJECT_STORAGE_ACCESS_KEY_ID, OBJECT_STORAGE_SECRET_ACCESS_KEY) is required in production.'
    );
  }

  const db: DbAdapter =
    options.dbAdapter ??
    (await createDatabaseAdapter({
      databaseUrl: options.databaseUrl,
      sqlitePath: options.dbPath,
      runMigrations: options.runMigrations,
    }));

  const { requireAuth, requireOrgContext, requireOrgRole } = createAuthMiddleware(db);
  const allowedCorsOrigins = getAllowedCorsOrigins();

  const app = express();
  app.set('trust proxy', 1);

  // Strict credentialed CORS (never uses Access-Control-Allow-Origin: * with credentials)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (isOriginPermitted(req, origin, allowedCorsOrigins)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, X-Org-Id, X-Client-Context, X-Client-Protocol'
        );
        if (req.method === 'OPTIONS') {
          return res.status(204).end();
        }
      } else if (req.method === 'OPTIONS') {
        return res.status(403).json({ error: 'Origin not permitted by CORS policy.' });
      }
    }
    next();
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // -------------------------------------------------------------
  // HEALTH CHECK (PUBLIC — VERIFIES DB + CONFIGURED OBJECT STORAGE)
  // -------------------------------------------------------------
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      await db.healthCheck();
      const storageStatus = await storage.healthCheck();
      res.json({
        status: 'ok',
        database: db.dialect,
        storage: storageStatus.status,
        timestamp: new Date().toISOString(),
      });
    })
  );

  // -------------------------------------------------------------
  // AUTHENTICATION & SESSION MANAGEMENT
  // -------------------------------------------------------------
  app.post(
    '/api/auth/register',
    asyncHandler(async (req, res) => {
      const { name, email, password, orgName, seedStarterBrand } = req.body || {};
      const cleanName = String(name || '').trim();
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanPassword = String(password || '');
      const cleanOrgName = String(orgName || '').trim();

      if (!cleanName || cleanName.length < 2) {
        return res.status(400).json({ error: 'Full name (at least 2 characters) is required.' });
      }
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'A valid email address is required.' });
      }
      if (cleanPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      }
      if (!cleanOrgName || cleanOrgName.length < 2) {
        return res.status(400).json({ error: 'Organisation name (at least 2 characters) is required.' });
      }

      const existingUser = await db.queryOne('SELECT id FROM users WHERE LOWER(email) = $1', [cleanEmail]);
      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      const now = new Date().toISOString();
      const userId = `USR-${crypto.randomUUID().slice(0, 12)}`;
      const orgId = `ORG-${crypto.randomUUID().slice(0, 12)}`;
      const baseSlug = slugifyOrgName(cleanOrgName);
      const slug = `${baseSlug}-${crypto.randomUUID().slice(0, 5)}`;
      const passwordHash = hashPassword(cleanPassword);

      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO users (id, name, email, password_hash, role, avatar, is_active, created_at, last_login_at)
           VALUES ($1, $2, $3, $4, 'admin', '/assets/avatar_brand_manager.jpg', 1, $5, $6)`,
          [userId, cleanName, cleanEmail, passwordHash, now, now]
        );

        await tx.query(
          `INSERT INTO organisations (id, name, slug, brand_settings, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            orgId,
            cleanOrgName,
            slug,
            JSON.stringify({
              primaryColors: ['#0F172A', '#0D9488', '#F8FAFC'],
              approvedFonts: ['Plus Jakarta Sans', 'JetBrains Mono'],
            }),
            now,
          ]
        );

        await tx.query(
          `INSERT INTO organisation_members (id, org_id, user_id, role, created_at)
           VALUES ($1, $2, $3, 'admin', $4)`,
          [`MEM-${crypto.randomUUID().slice(0, 12)}`, orgId, userId, now]
        );
      });

      if (seedStarterBrand !== false) {
        await seedStarterWorkspaceForOrg(db, orgId, userId, cleanOrgName);
      }

      const session = await createSession(db, userId, orgId, {
        ipAddress: req.ip,
        userAgent: req.header('user-agent'),
      });

      await recordAuditLog(db, {
        orgId,
        actorId: userId,
        actorRole: 'admin',
        action: 'AUTH_REGISTER',
        entityType: 'user',
        entityId: userId,
        details: { orgName: cleanOrgName, seededStarter: seedStarterBrand !== false },
      });

      const cookiePolicy = resolveCookiePolicy(req);
      logAuthDiagnostic('register_success', {
        userId,
        orgId,
        sessionId: session.sessionId,
        isHttps: isRequestHttps(req),
        xForwardedProto: (req.header('x-forwarded-proto') || '').split(',')[0].trim() || null,
        clientContext: req.header('x-client-context') || null,
        cookieContext: cookiePolicy.context,
        sameSite: cookiePolicy.sameSite,
        secure: cookiePolicy.secure,
        partitioned: cookiePolicy.partitioned,
        expiresAt: session.expiresAt,
      });

      res.setHeader('Set-Cookie', buildSessionCookieHeader(session.rawToken, cookiePolicy, session.expiresAt));

      res.status(201).json({
        user: {
          id: userId,
          name: cleanName,
          email: cleanEmail,
          role: 'admin',
          avatar: '/assets/avatar_brand_manager.jpg',
        },
        activeOrg: { orgId, name: cleanOrgName, slug, role: 'admin' as OrgRole },
        memberships: [{ orgId, name: cleanOrgName, slug, role: 'admin' as OrgRole }],
        role: 'admin' as OrgRole,
      });
    })
  );

  app.post(
    '/api/auth/login',
    asyncHandler(async (req, res) => {
      const { email, password } = req.body || {};
      const cleanEmail = String(email || '').trim().toLowerCase();
      const rawPassword = String(password || '');

      if (!cleanEmail || !rawPassword) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      const userRow = await db.queryOne<any>(
        'SELECT id, name, email, password_hash, avatar, is_active FROM users WHERE LOWER(email) = $1',
        [cleanEmail]
      );

      if (!userRow || !userRow.is_active || !verifyPassword(rawPassword, userRow.password_hash)) {
        logAuthDiagnostic('login_failed', {
          reason: !userRow ? 'user_not_found' : !userRow.is_active ? 'inactive_user' : 'invalid_password',
        });
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const membershipsRes = await db.query<{ orgId: string; role: OrgRole; name: string; slug: string }>(
        `SELECT om.org_id as "orgId", om.role, o.name, o.slug
         FROM organisation_members om
         JOIN organisations o ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY o.created_at ASC`,
        [userRow.id]
      );
      const memberships = membershipsRes.rows;

      if (memberships.length === 0) {
        logAuthDiagnostic('login_failed', { reason: 'no_org_membership', userId: userRow.id });
        return res.status(403).json({ error: 'Account is not assigned to any active organisation.' });
      }

      // Rotate any stale/existing cookie session carried by the same browser so duplicate sessions don't pile up
      const previousToken = extractRawToken(req);
      if (previousToken) {
        await revokeSession(db, previousToken);
      }

      const activeOrg = memberships[0];
      const now = new Date().toISOString();
      await db.query('UPDATE users SET last_login_at = $1 WHERE id = $2', [now, userRow.id]);

      const session = await createSession(db, userRow.id, activeOrg.orgId, {
        ipAddress: req.ip,
        userAgent: req.header('user-agent'),
      });

      await recordAuditLog(db, {
        orgId: activeOrg.orgId,
        actorId: userRow.id,
        actorRole: activeOrg.role,
        action: 'AUTH_LOGIN',
        entityType: 'session',
        entityId: session.sessionId,
      });

      const cookiePolicy = resolveCookiePolicy(req);
      logAuthDiagnostic('login_success', {
        userId: userRow.id,
        orgId: activeOrg.orgId,
        sessionId: session.sessionId,
        isHttps: isRequestHttps(req),
        xForwardedProto: (req.header('x-forwarded-proto') || '').split(',')[0].trim() || null,
        clientContext: req.header('x-client-context') || null,
        cookieContext: cookiePolicy.context,
        sameSite: cookiePolicy.sameSite,
        secure: cookiePolicy.secure,
        partitioned: cookiePolicy.partitioned,
        expiresAt: session.expiresAt,
      });

      res.setHeader('Set-Cookie', buildSessionCookieHeader(session.rawToken, cookiePolicy, session.expiresAt));

      res.json({
        user: {
          id: userRow.id,
          name: userRow.name,
          email: userRow.email,
          role: activeOrg.role,
          avatar: userRow.avatar,
        },
        activeOrg,
        memberships,
        role: activeOrg.role,
      });
    })
  );

  app.post(
    '/api/auth/logout',
    asyncHandler(async (req: AuthRequest, res) => {
      const rawToken = extractRawToken(req);
      if (rawToken) {
        const session = await resolveSession(db, rawToken);
        if (session) {
          const membership = await db.queryOne<{ role?: string }>(
            'SELECT role FROM organisation_members WHERE org_id = $1 AND user_id = $2',
            [session.activeOrgId, session.userId]
          );
          await recordAuditLog(db, {
            orgId: session.activeOrgId,
            actorId: session.userId,
            actorRole: membership?.role || null,
            action: 'AUTH_LOGOUT',
            entityType: 'session',
            entityId: session.sessionId,
          });
          logAuthDiagnostic('logout_success', {
            userId: session.userId,
            orgId: session.activeOrgId,
            sessionId: session.sessionId,
          });
        }
        await revokeSession(db, rawToken);
      }

      const cookiePolicy = resolveCookiePolicy(req);
      res.setHeader('Set-Cookie', buildClearSessionCookieHeader(cookiePolicy));
      res.json({ success: true });
    })
  );

  // Non-failing bootstrap session check for app mount (avoids 401 / false-positive missing-cookie errors before sign-in)
  app.get(
    '/api/auth/session',
    asyncHandler(async (req: AuthRequest, res) => {
      const rawToken = extractRawToken(req);
      if (!rawToken) {
        return res.json({
          authenticated: false,
          user: null,
          activeOrg: null,
          memberships: [],
          role: null,
        });
      }

      const session = await resolveSession(db, rawToken);
      if (!session) {
        return res.json({
          authenticated: false,
          expired: true,
          user: null,
          activeOrg: null,
          memberships: [],
          role: null,
        });
      }

      const membershipsRes = await db.query<{ orgId: string; role: OrgRole; name: string; slug: string }>(
        `SELECT om.org_id as "orgId", om.role, o.name, o.slug
         FROM organisation_members om
         JOIN organisations o ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY o.created_at ASC`,
        [session.user.id]
      );
      const memberships = membershipsRes.rows;
      const requestedOrgId = (req.header('x-org-id') || '').trim() || session.activeOrgId;
      const activeMembership =
        memberships.find((m) => m.orgId === requestedOrgId) ||
        memberships.find((m) => m.orgId === session.activeOrgId) ||
        memberships[0];

      if (!activeMembership) {
        return res.json({
          authenticated: false,
          user: null,
          activeOrg: null,
          memberships: [],
          role: null,
        });
      }

      return res.json({
        authenticated: true,
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          avatar: session.user.avatar,
          role: activeMembership.role,
        },
        activeOrg: {
          orgId: activeMembership.orgId,
          name: activeMembership.name,
          slug: activeMembership.slug,
          role: activeMembership.role,
        },
        memberships,
        role: activeMembership.role,
      });
    })
  );

  app.get(
    '/api/auth/me',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const membershipsRes = await db.query<{ orgId: string; role: OrgRole; name: string; slug: string }>(
        `SELECT om.org_id as "orgId", om.role, o.name, o.slug
         FROM organisation_members om
         JOIN organisations o ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY o.created_at ASC`,
        [auth.user.id]
      );

      logAuthDiagnostic('session_verified', {
        userId: auth.user.id,
        orgId: auth.orgId,
        sessionId: auth.sessionId,
      });

      res.json({
        user: {
          ...auth.user,
          role: auth.role,
        },
        activeOrg: {
          orgId: auth.orgId,
          name: auth.org.name,
          slug: auth.org.slug,
          role: auth.role,
        },
        memberships: membershipsRes.rows,
        role: auth.role,
      });
    })
  );

  app.post(
    '/api/auth/switch-org',
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { orgId } = req.body || {};
      const targetOrgId = String(orgId || '').trim();
      if (!targetOrgId) {
        return res.status(400).json({ error: 'orgId is required.' });
      }

      const session = req.sessionOnly!;
      const membership = await db.queryOne<{ orgId: string; role: OrgRole; name: string; slug: string }>(
        `SELECT om.org_id as "orgId", om.role, o.name, o.slug
         FROM organisation_members om
         JOIN organisations o ON o.id = om.org_id
         WHERE om.org_id = $1 AND om.user_id = $2`,
        [targetOrgId, session.user.id]
      );

      if (!membership) {
        return res.status(403).json({ error: 'Forbidden: You are not a member of this organisation.' });
      }

      await db.query('UPDATE sessions SET active_org_id = $1 WHERE id = $2', [targetOrgId, session.sessionId]);

      await recordAuditLog(db, {
        orgId: targetOrgId,
        actorId: session.user.id,
        actorRole: membership.role,
        action: 'ORG_SWITCHED',
        entityType: 'organisation',
        entityId: targetOrgId,
      });

      res.json({
        success: true,
        activeOrg: membership,
        role: membership.role,
      });
    })
  );

  // -------------------------------------------------------------
  // ORGANISATIONS & MEMBERS (AUTHENTICATED + TENANT SCOPED)
  // -------------------------------------------------------------
  app.get(
    '/api/orgs',
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const membershipsRes = await db.query(
        `SELECT om.org_id as "orgId", om.role, o.name, o.slug, o.created_at
         FROM organisation_members om
         JOIN organisations o ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY o.created_at ASC`,
        [req.sessionOnly!.user.id]
      );
      res.json({ organisations: membershipsRes.rows });
    })
  );

  app.post(
    '/api/orgs',
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { name, seedStarterBrand } = req.body || {};
      const cleanOrgName = String(name || '').trim();
      if (!cleanOrgName || cleanOrgName.length < 2) {
        return res.status(400).json({ error: 'Organisation name must be at least 2 characters.' });
      }

      const userId = req.sessionOnly!.user.id;
      const now = new Date().toISOString();
      const orgId = `ORG-${crypto.randomUUID().slice(0, 12)}`;
      const slug = `${slugifyOrgName(cleanOrgName)}-${crypto.randomUUID().slice(0, 5)}`;

      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO organisations (id, name, slug, brand_settings, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            orgId,
            cleanOrgName,
            slug,
            JSON.stringify({
              primaryColors: ['#0F172A', '#0D9488', '#F8FAFC'],
              approvedFonts: ['Plus Jakarta Sans', 'JetBrains Mono'],
            }),
            now,
          ]
        );

        await tx.query(
          `INSERT INTO organisation_members (id, org_id, user_id, role, created_at)
           VALUES ($1, $2, $3, 'admin', $4)`,
          [`MEM-${crypto.randomUUID().slice(0, 12)}`, orgId, userId, now]
        );

        await tx.query('UPDATE sessions SET active_org_id = $1 WHERE id = $2', [orgId, req.sessionOnly!.sessionId]);
      });

      if (seedStarterBrand) {
        await seedStarterWorkspaceForOrg(db, orgId, userId, cleanOrgName);
      }

      await recordAuditLog(db, {
        orgId,
        actorId: userId,
        actorRole: 'admin',
        action: 'ORG_CREATED',
        entityType: 'organisation',
        entityId: orgId,
        details: { name: cleanOrgName, seededStarter: Boolean(seedStarterBrand) },
      });

      res.status(201).json({
        activeOrg: { orgId, name: cleanOrgName, slug, role: 'admin' as OrgRole },
      });
    })
  );

  app.get(
    '/api/orgs/:orgId/members',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      if (req.params.orgId !== auth.orgId) {
        return res.status(403).json({ error: 'Forbidden: Cross-organisation member access is denied.' });
      }

      const membersRes = await db.query(
        `SELECT u.id, u.name, u.email, om.role, u.avatar, om.created_at as joined_at
         FROM organisation_members om
         JOIN users u ON u.id = om.user_id
         WHERE om.org_id = $1
         ORDER BY om.created_at ASC`,
        [auth.orgId]
      );

      res.json({ members: membersRes.rows });
    })
  );

  app.post(
    '/api/orgs/:orgId/members',
    requireAuth,
    requireOrgContext,
    requireOrgRole('admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      if (req.params.orgId !== auth.orgId) {
        return res.status(403).json({ error: 'Forbidden: Cross-organisation mutation denied.' });
      }

      const { name, email, password, role } = req.body || {};
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanName = String(name || '').trim();
      const cleanRole = String(role || '') as OrgRole;

      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'Valid email address is required.' });
      }
      if (!['creator', 'brand_manager', 'admin'].includes(cleanRole)) {
        return res.status(400).json({ error: 'Role must be creator, brand_manager, or admin.' });
      }

      const now = new Date().toISOString();
      let targetUser = await db.queryOne<any>('SELECT id, name, email, avatar FROM users WHERE LOWER(email) = $1', [
        cleanEmail,
      ]);

      if (!targetUser) {
        const rawPass = String(password || '');
        if (!cleanName || cleanName.length < 2) {
          return res.status(400).json({ error: 'Member full name is required for new accounts.' });
        }
        if (rawPass.length < 8) {
          return res.status(400).json({ error: 'Initial password (min 8 chars) is required for new accounts.' });
        }
        const newUserId = `USR-${crypto.randomUUID().slice(0, 12)}`;
        const passwordHash = hashPassword(rawPass);
        await db.query(
          `INSERT INTO users (id, name, email, password_hash, role, avatar, is_active, created_at)
           VALUES ($1, $2, $3, $4, $5, '/assets/avatar_brand_manager.jpg', 1, $6)`,
          [newUserId, cleanName, cleanEmail, passwordHash, cleanRole, now]
        );

        targetUser = {
          id: newUserId,
          name: cleanName,
          email: cleanEmail,
          avatar: '/assets/avatar_brand_manager.jpg',
        };
      }

      const existingMembership = await db.queryOne(
        'SELECT id FROM organisation_members WHERE org_id = $1 AND user_id = $2',
        [auth.orgId, targetUser.id]
      );
      if (existingMembership) {
        return res.status(409).json({ error: 'User is already a member of this organisation.' });
      }

      await db.query(
        `INSERT INTO organisation_members (id, org_id, user_id, role, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [`MEM-${crypto.randomUUID().slice(0, 12)}`, auth.orgId, targetUser.id, cleanRole, now]
      );

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'MEMBER_ADDED',
        entityType: 'organisation_member',
        entityId: targetUser.id,
        details: { email: cleanEmail, role: cleanRole },
      });

      res.status(201).json({
        member: {
          id: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
          role: cleanRole,
          avatar: targetUser.avatar,
          joined_at: now,
        },
      });
    })
  );

  app.patch(
    '/api/orgs/:orgId/members/:userId',
    requireAuth,
    requireOrgContext,
    requireOrgRole('admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      if (req.params.orgId !== auth.orgId) {
        return res.status(403).json({ error: 'Forbidden: Cross-organisation mutation denied.' });
      }

      const targetUserId = req.params.userId;
      const newRole = String(req.body?.role || '') as OrgRole;
      if (!['creator', 'brand_manager', 'admin'].includes(newRole)) {
        return res.status(400).json({ error: 'Role must be creator, brand_manager, or admin.' });
      }

      const existing = await db.queryOne<{ role: OrgRole }>(
        'SELECT role FROM organisation_members WHERE org_id = $1 AND user_id = $2',
        [auth.orgId, targetUserId]
      );

      if (!existing) {
        return res.status(404).json({ error: 'Member not found in this organisation.' });
      }

      if (existing.role === 'admin' && newRole !== 'admin') {
        const adminCountRow = await db.queryOne<{ c: any }>(
          "SELECT COUNT(*) as c FROM organisation_members WHERE org_id = $1 AND role = 'admin'",
          [auth.orgId]
        );
        if (Number(adminCountRow?.c ?? 0) <= 1) {
          return res.status(400).json({ error: 'Cannot demote the sole remaining organisation Administrator.' });
        }
      }

      await db.query('UPDATE organisation_members SET role = $1 WHERE org_id = $2 AND user_id = $3', [
        newRole,
        auth.orgId,
        targetUserId,
      ]);

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'MEMBER_ROLE_UPDATED',
        entityType: 'organisation_member',
        entityId: targetUserId,
        details: { previousRole: existing.role, newRole },
      });

      res.json({ success: true, userId: targetUserId, role: newRole });
    })
  );

  // -------------------------------------------------------------
  // ORGANISATION BRAND SETTINGS (PALETTE & APPROVED FONTS)
  // -------------------------------------------------------------
  app.get(
    '/api/org/brand-settings',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const org = await db.queryOne<{ brand_settings: any }>(
        'SELECT brand_settings FROM organisations WHERE id = $1',
        [req.auth!.orgId]
      );
      let settings = {
        primaryColors: ['#0F172A', '#0D9488', '#F8FAFC'],
        approvedFonts: ['Plus Jakarta Sans', 'JetBrains Mono'],
      };
      if (org?.brand_settings) {
        try {
          const parsed =
            typeof org.brand_settings === 'string' ? JSON.parse(org.brand_settings) : org.brand_settings;
          if (Array.isArray(parsed.primaryColors) && parsed.primaryColors.length > 0) {
            settings.primaryColors = parsed.primaryColors;
          }
          if (Array.isArray(parsed.approvedFonts) && parsed.approvedFonts.length > 0) {
            settings.approvedFonts = parsed.approvedFonts;
          }
        } catch {
          // keep defaults
        }
      }
      res.json(settings);
    })
  );

  app.put(
    '/api/org/brand-settings',
    requireAuth,
    requireOrgContext,
    requireOrgRole('admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { primaryColors, approvedFonts } = req.body || {};

      if (!Array.isArray(primaryColors) || primaryColors.length === 0) {
        return res.status(400).json({ error: 'At least one approved HEX brand colour is required.' });
      }
      if (!Array.isArray(approvedFonts) || approvedFonts.length === 0) {
        return res.status(400).json({ error: 'At least one approved font family is required.' });
      }

      const normalizedColors: string[] = [];
      for (const c of primaryColors) {
        const norm = normalizeHex(String(c));
        if (!norm) {
          return res.status(400).json({ error: `Invalid HEX colour "${c}". Expected format like #0F172A.` });
        }
        if (!normalizedColors.includes(norm)) normalizedColors.push(norm);
      }

      const cleanedFonts = Array.from(
        new Set(approvedFonts.map((f: any) => String(f || '').trim()).filter((f: string) => f.length > 0))
      );
      if (cleanedFonts.length === 0) {
        return res.status(400).json({ error: 'At least one valid font family name is required.' });
      }

      const payload = { primaryColors: normalizedColors, approvedFonts: cleanedFonts };
      await db.query('UPDATE organisations SET brand_settings = $1::jsonb WHERE id = $2', [
        JSON.stringify(payload),
        auth.orgId,
      ]);

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'ORG_BRAND_SETTINGS_UPDATED',
        entityType: 'organisation',
        entityId: auth.orgId,
        details: payload,
      });

      res.json(payload);
    })
  );

  // -------------------------------------------------------------
  // BRAND KNOWLEDGE HUB: GUIDELINES (ORG-ISOLATED + MANAGER/ADMIN WRITE)
  // -------------------------------------------------------------
  app.get(
    '/api/guidelines',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const result = await db.query('SELECT * FROM guidelines WHERE org_id = $1 ORDER BY created_at DESC', [
        req.auth!.orgId,
      ]);
      res.json(result.rows);
    })
  );

  app.post(
    '/api/guidelines',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { title, category, description, severity, source_document, prohibited_phrase, preferred_replacement } =
        req.body || {};
      if (!title || !category || !description || !severity) {
        return res.status(400).json({ error: 'Title, category, description, and severity are required.' });
      }
      const id = `RULE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const createdAt = new Date().toISOString();
      await db.query(
        `INSERT INTO guidelines (id, org_id, title, category, description, severity, source_document, prohibited_phrase, preferred_replacement, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          auth.orgId,
          title,
          category,
          description,
          severity,
          source_document || 'Direct Manual Entry',
          prohibited_phrase || null,
          preferred_replacement || null,
          createdAt,
        ]
      );

      const created = await db.queryOne('SELECT * FROM guidelines WHERE id = $1 AND org_id = $2', [id, auth.orgId]);

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'GUIDELINE_CREATED',
        entityType: 'guideline',
        entityId: id,
        details: { title, category, severity },
      });

      res.status(201).json(created);
    })
  );

  app.put(
    '/api/guidelines/:id',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id } = req.params;
      const { title, category, description, severity, source_document, prohibited_phrase, preferred_replacement } =
        req.body || {};
      if (!title || !category || !description || !severity) {
        return res.status(400).json({ error: 'Title, category, description, and severity are required.' });
      }
      const result = await db.query(
        `UPDATE guidelines
         SET title = $1, category = $2, description = $3, severity = $4, source_document = $5, prohibited_phrase = $6, preferred_replacement = $7
         WHERE id = $8 AND org_id = $9`,
        [
          title,
          category,
          description,
          severity,
          source_document || 'Direct Manual Entry',
          prohibited_phrase || null,
          preferred_replacement || null,
          id,
          auth.orgId,
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Guideline not found in your organisation.' });
      }

      const updated = await db.queryOne('SELECT * FROM guidelines WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'GUIDELINE_UPDATED',
        entityType: 'guideline',
        entityId: id,
        details: { title, category, severity },
      });
      res.json(updated);
    })
  );

  app.delete(
    '/api/guidelines/:id',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id } = req.params;
      const result = await db.query('DELETE FROM guidelines WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Guideline not found in your organisation.' });
      }
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'GUIDELINE_DELETED',
        entityType: 'guideline',
        entityId: id,
      });
      res.json({ success: true, id });
    })
  );

  // -------------------------------------------------------------
  // BRAND KNOWLEDGE HUB: APPROVED FACTS
  // -------------------------------------------------------------
  app.get(
    '/api/facts',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const result = await db.query('SELECT * FROM approved_facts WHERE org_id = $1 ORDER BY verified_at DESC', [
        req.auth!.orgId,
      ]);
      res.json(result.rows);
    })
  );

  app.post(
    '/api/facts',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { fact, source } = req.body || {};
      if (!fact || !source) {
        return res.status(400).json({ error: 'Fact statement and verifiable source are required.' });
      }
      const id = `FACT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO approved_facts (id, org_id, fact, source, verified_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, auth.orgId, fact, source, now, now]
      );

      const created = await db.queryOne('SELECT * FROM approved_facts WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'FACT_CREATED',
        entityType: 'approved_fact',
        entityId: id,
        details: { source },
      });
      res.status(201).json(created);
    })
  );

  app.delete(
    '/api/facts/:id',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id } = req.params;
      const result = await db.query('DELETE FROM approved_facts WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Approved fact not found in your organisation.' });
      }
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'FACT_DELETED',
        entityType: 'approved_fact',
        entityId: id,
      });
      res.json({ success: true, id });
    })
  );

  // -------------------------------------------------------------
  // BRAND KNOWLEDGE HUB: TERMINOLOGY
  // -------------------------------------------------------------
  app.get(
    '/api/terminology',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const result = await db.query('SELECT * FROM terminology WHERE org_id = $1 ORDER BY created_at DESC', [
        req.auth!.orgId,
      ]);
      res.json(result.rows);
    })
  );

  app.post(
    '/api/terminology',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { prohibited_term, preferred_term, explanation } = req.body || {};
      if (!prohibited_term || !preferred_term) {
        return res.status(400).json({ error: 'Prohibited term and preferred term are required.' });
      }
      const id = `TERM-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO terminology (id, org_id, prohibited_term, preferred_term, explanation, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, auth.orgId, prohibited_term, preferred_term, explanation || '', now]
      );

      const created = await db.queryOne('SELECT * FROM terminology WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'TERMINOLOGY_CREATED',
        entityType: 'terminology',
        entityId: id,
        details: { prohibited_term, preferred_term },
      });
      res.status(201).json(created);
    })
  );

  app.delete(
    '/api/terminology/:id',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id } = req.params;
      const result = await db.query('DELETE FROM terminology WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Terminology rule not found in your organisation.' });
      }
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'TERMINOLOGY_DELETED',
        entityType: 'terminology',
        entityId: id,
      });
      res.json({ success: true, id });
    })
  );

  // -------------------------------------------------------------
  // BRAND KNOWLEDGE HUB: ASSETS & S3 PERSISTENT OBJECT STORAGE
  // -------------------------------------------------------------
  app.get(
    '/api/assets',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const result = await db.query('SELECT * FROM assets WHERE org_id = $1 ORDER BY created_at DESC', [
        req.auth!.orgId,
      ]);
      res.json(result.rows);
    })
  );

  app.post(
    '/api/assets',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { asset_name, asset_type, file_path, guidelines, fileBase64, fileName, mimeType } = req.body || {};
      if (!asset_name || !asset_type) {
        return res.status(400).json({ error: 'Asset name and type are required.' });
      }

      const now = new Date().toISOString();
      let resolvedFilePath = file_path || '/assets/novatech_brand_logo.jpg';

      if (fileBase64 && fileName) {
        const buf = Buffer.from(fileBase64, 'base64');
        const fileId = `FILE-${crypto.randomUUID().slice(0, 10)}`;
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const safeMime = mimeType || 'application/octet-stream';

        if (storage.isConfigured()) {
          const location = await storage.uploadObject({
            orgId: auth.orgId,
            fileId,
            fileName,
            mimeType: safeMime,
            buffer: buf,
          });

          try {
            await db.query(
              `INSERT INTO stored_files (id, org_id, storage_provider, bucket, object_key, filename, mime_type, size_bytes, sha256, data_base64, uploaded_by, created_at)
               VALUES ($1, $2, 's3', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                fileId,
                auth.orgId,
                location.bucket,
                location.objectKey,
                fileName,
                safeMime,
                buf.length,
                sha256,
                db.dialect === 'postgres' ? null : '',
                auth.user.id,
                now,
              ]
            );
          } catch (dbErr) {
            await storage.deleteObject(location.objectKey).catch(() => undefined);
            throw dbErr;
          }
        } else if (db.dialect === 'sqlite' && process.env.NODE_ENV !== 'production') {
          await db.query(
            `INSERT INTO stored_files (id, org_id, storage_provider, bucket, object_key, filename, mime_type, size_bytes, sha256, data_base64, uploaded_by, created_at)
             VALUES ($1, $2, 'sqlite_dev', NULL, NULL, $3, $4, $5, $6, $7, $8, $9)`,
            [fileId, auth.orgId, fileName, safeMime, buf.length, sha256, fileBase64, auth.user.id, now]
          );
        } else {
          throw new StorageUnavailableError(
            'Persistent object storage is not configured. Configure S3 credentials before uploading assets.'
          );
        }

        resolvedFilePath = `/api/files/${fileId}`;
      }

      const id = `ASSET-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      await db.query(
        `INSERT INTO assets (id, org_id, asset_name, asset_type, file_path, guidelines, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, auth.orgId, asset_name, asset_type, resolvedFilePath, guidelines || '', now]
      );

      const created = await db.queryOne('SELECT * FROM assets WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'ASSET_CREATED',
        entityType: 'asset',
        entityId: id,
        details: { asset_name, asset_type },
      });
      res.status(201).json(created);
    })
  );

  app.delete(
    '/api/assets/:id',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id } = req.params;
      const existing = await db.queryOne<{ id: string; file_path: string }>(
        'SELECT id, file_path FROM assets WHERE id = $1 AND org_id = $2',
        [id, auth.orgId]
      );

      if (!existing) {
        return res.status(404).json({ error: 'Asset not found in your organisation.' });
      }

      await db.query('DELETE FROM assets WHERE id = $1 AND org_id = $2', [id, auth.orgId]);

      if (existing.file_path && existing.file_path.startsWith('/api/files/')) {
        const fileId = existing.file_path.slice('/api/files/'.length);
        const fileRow = await db.queryOne<{ storage_provider?: string; object_key?: string }>(
          'SELECT storage_provider, object_key FROM stored_files WHERE id = $1 AND org_id = $2',
          [fileId, auth.orgId]
        );
        if (fileRow?.storage_provider === 's3' && fileRow.object_key) {
          await storage.deleteObject(fileRow.object_key);
        }
        await db.query('DELETE FROM stored_files WHERE id = $1 AND org_id = $2', [fileId, auth.orgId]);
      }

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'ASSET_DELETED',
        entityType: 'asset',
        entityId: id,
      });
      res.json({ success: true, id });
    })
  );

  app.get(
    '/api/files/:id',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const fileRow = await db.queryOne<any>(
        `SELECT filename, mime_type, storage_provider, object_key, data_base64
         FROM stored_files
         WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.auth!.orgId]
      );

      if (!fileRow) {
        return res.status(404).json({ error: 'File not found in your organisation.' });
      }

      let buf: Buffer;
      if (fileRow.storage_provider === 's3' && fileRow.object_key) {
        buf = await storage.downloadObject(fileRow.object_key);
      } else if (fileRow.data_base64) {
        buf = Buffer.from(fileRow.data_base64, 'base64');
      } else {
        return res.status(404).json({ error: 'Stored file payload is unavailable.' });
      }

      res.setHeader('Content-Type', fileRow.mime_type);
      res.setHeader('Content-Disposition', `inline; filename="${String(fileRow.filename).replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(buf);
    })
  );

  // -------------------------------------------------------------
  // RAG POLICY DOCUMENT INGESTION, INDEXING & HYBRID RETRIEVAL
  // -------------------------------------------------------------
  app.get(
    '/api/rag/documents',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const result = await db.query(
        `SELECT id, org_id, stored_file_id, filename, mime_type, size_bytes, sha256,
                page_count, chunk_count, ocr_used, indexing_status, warnings, uploaded_by, created_at
         FROM rag_documents
         WHERE org_id = $1
         ORDER BY created_at DESC`,
        [req.auth!.orgId]
      );
      res.json({
        documents: result.rows.map((d: any) => ({
          ...d,
          size_bytes: Number(d.size_bytes ?? 0),
          page_count: Number(d.page_count ?? 1),
          chunk_count: Number(d.chunk_count ?? 0),
          ocr_used: Boolean(d.ocr_used),
          warnings: (() => {
            try {
              return typeof d.warnings === 'string' ? JSON.parse(d.warnings || '[]') : d.warnings || [];
            } catch {
              return [];
            }
          })(),
        })),
      });
    })
  );

  app.post(
    '/api/rag/documents',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { fileBase64, fileName, mimeType } = req.body || {};
      if (!fileBase64 || !fileName) {
        return res.status(400).json({ error: 'fileBase64 and fileName are required.' });
      }

      const fileBuffer = Buffer.from(String(fileBase64), 'base64');
      const summary = await ingestOrgDocument({
        db,
        storage,
        orgId: auth.orgId,
        userId: auth.user.id,
        fileBuffer,
        fileName: String(fileName),
        mimeType: mimeType ? String(mimeType) : undefined,
      });

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'RAG_DOCUMENT_INDEXED',
        entityType: 'rag_document',
        entityId: summary.id,
        details: {
          filename: summary.filename,
          chunkCount: summary.chunk_count,
          pageCount: summary.page_count,
          ocrUsed: summary.ocr_used,
          indexingStatus: summary.indexing_status,
        },
      });

      res.status(201).json({ document: summary });
    })
  );

  app.delete(
    '/api/rag/documents/:id',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const doc = await db.queryOne<{ id: string; stored_file_id: string | null; filename: string }>(
        'SELECT id, stored_file_id, filename FROM rag_documents WHERE id = $1 AND org_id = $2',
        [req.params.id, auth.orgId]
      );
      if (!doc) {
        return res.status(404).json({ error: 'Indexed policy document not found in your organisation.' });
      }

      await db.transaction(async (tx) => {
        await tx.query('DELETE FROM document_chunks WHERE document_id = $1 AND org_id = $2', [doc.id, auth.orgId]);
        await tx.query('DELETE FROM rag_documents WHERE id = $1 AND org_id = $2', [doc.id, auth.orgId]);
      });

      if (doc.stored_file_id) {
        const fileRow = await db.queryOne<{ storage_provider?: string; object_key?: string }>(
          'SELECT storage_provider, object_key FROM stored_files WHERE id = $1 AND org_id = $2',
          [doc.stored_file_id, auth.orgId]
        );
        if (fileRow?.storage_provider === 's3' && fileRow.object_key) {
          await storage.deleteObject(fileRow.object_key);
        }
        await db.query('DELETE FROM stored_files WHERE id = $1 AND org_id = $2', [doc.stored_file_id, auth.orgId]);
      }

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'RAG_DOCUMENT_DELETED',
        entityType: 'rag_document',
        entityId: doc.id,
        details: { filename: doc.filename },
      });

      res.json({ success: true, id: doc.id });
    })
  );

  app.post(
    '/api/rag/search',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const { query, topK } = req.body || {};
      const cleanQuery = String(query || '').trim();
      if (!cleanQuery) {
        return res.status(400).json({ error: 'Search query text is required.' });
      }
      const limit = Math.min(20, Math.max(1, Number(topK || 8)));
      const retrieval = await retrieveOrgEvidence(db, req.auth!.orgId, cleanQuery, limit);
      res.json(retrieval);
    })
  );

  // -------------------------------------------------------------
  // DOCUMENT EXTRACTION ENDPOINT (IN-MEMORY + OPTIONAL S3 PERSISTENCE)
  // -------------------------------------------------------------
  app.post(
    '/api/documents/parse',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { fileBase64, fileName, mimeType, persist } = req.body || {};
      if (!fileBase64 || !fileName) {
        return res.status(400).json({ error: 'File data and fileName required.' });
      }

      const buffer = Buffer.from(fileBase64, 'base64');
      const extracted = await extractTextFromFile(buffer, fileName, mimeType);

      let storedFileId: string | undefined;
      if (persist) {
        if (!storage.isConfigured()) {
          throw new StorageUnavailableError(
            'Persistent object storage is not configured. Unable to archive uploaded document.'
          );
        }
        const fileId = `DOC-${crypto.randomUUID().slice(0, 10)}`;
        const now = new Date().toISOString();
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const safeMime = mimeType || 'application/octet-stream';
        const location = await storage.uploadObject({
          orgId: auth.orgId,
          fileId,
          fileName,
          mimeType: safeMime,
          buffer,
        });
        await db.query(
          `INSERT INTO stored_files (id, org_id, storage_provider, bucket, object_key, filename, mime_type, size_bytes, sha256, data_base64, uploaded_by, created_at)
           VALUES ($1, $2, 's3', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            fileId,
            auth.orgId,
            location.bucket,
            location.objectKey,
            fileName,
            safeMime,
            buffer.length,
            sha256,
            db.dialect === 'postgres' ? null : '',
            auth.user.id,
            now,
          ]
        );
        storedFileId = fileId;
      }

      res.json({ ...extracted, storedFileId });
    })
  );

  // -------------------------------------------------------------
  // CONTENT REVIEW & COMPLIANCE ANALYSIS (ORG-ISOLATED + RBAC)
  // -------------------------------------------------------------
  app.post(
    '/api/submissions/analyze',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { title, content, content_type, submission_id } = req.body || {};
      if (!content || !String(content).trim()) {
        return res.status(400).json({ error: 'Content text is required for analysis.' });
      }

      const currentTitle = String(title || '').trim() || 'Untitled Submission';
      const contentType = String(content_type || 'Social Media');
      const cleanContent = String(content);

      if (submission_id) {
        const existingSub = await db.queryOne<{ id: string; created_by: string; status: string }>(
          'SELECT id, created_by, status FROM submissions WHERE id = $1 AND org_id = $2',
          [submission_id, auth.orgId]
        );

        if (!existingSub) {
          return res.status(404).json({ error: 'Submission not found in your organisation.' });
        }
        if (existingSub.created_by !== auth.user.id && auth.role !== 'admin') {
          return res.status(403).json({
            error: 'Forbidden: Only the submission creator or an Administrator can re-analyze this draft.',
          });
        }
        if (!['Draft', 'Needs Revision'].includes(existingSub.status)) {
          return res.status(400).json({ error: `Cannot re-analyze submission in "${existingSub.status}" status.` });
        }
      }

      const [guidelinesRes, factsRes, terminologyRes, retrieval] = await Promise.all([
        db.query('SELECT * FROM guidelines WHERE org_id = $1', [auth.orgId]),
        db.query('SELECT * FROM approved_facts WHERE org_id = $1', [auth.orgId]),
        db.query('SELECT * FROM terminology WHERE org_id = $1', [auth.orgId]),
        retrieveOrgEvidence(db, auth.orgId, cleanContent, 10),
      ]);

      const guidelines = guidelinesRes.rows;
      const facts = factsRes.rows;
      const terminology = terminologyRes.rows;

      let analysis: AnalysisResult | null = null;
      let usedAI = false;

      if (process.env.GEMINI_API_KEY) {
        analysis = await analyzeWithGemini(
          cleanContent,
          contentType,
          guidelines,
          facts,
          terminology,
          retrieval.items
        );
        if (analysis) {
          usedAI = true;
        }
      }

      if (!analysis) {
        analysis = analyzeWithRuleEngine(
          cleanContent,
          contentType,
          guidelines,
          facts,
          terminology,
          retrieval.items
        );
      }

      const now = new Date().toISOString();
      let subId = submission_id as string | undefined;

      await db.transaction(async (tx) => {
        if (!subId) {
          subId = `SUB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
          await tx.query(
            `INSERT INTO submissions (id, org_id, title, content, original_content, content_type, created_by, status, compliance_score, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'Draft', $8, $9, $10)`,
            [
              subId,
              auth.orgId,
              currentTitle,
              cleanContent,
              cleanContent,
              contentType,
              auth.user.id,
              analysis!.compliance_score,
              now,
              now,
            ]
          );

          await tx.query(
            `INSERT INTO content_versions (id, org_id, submission_id, version_number, content, created_by, change_summary, compliance_score, created_at)
             VALUES ($1, $2, $3, 1, $4, $5, 'Initial compliance scan', $6, $7)`,
            [`VER-${subId}-1`, auth.orgId, subId, cleanContent, auth.user.id, analysis!.compliance_score, now]
          );
        } else {
          await tx.query(
            `UPDATE submissions
             SET title = $1, content = $2, content_type = $3, compliance_score = $4, updated_at = $5
             WHERE id = $6 AND org_id = $7`,
            [currentTitle, cleanContent, contentType, analysis!.compliance_score, now, subId, auth.orgId]
          );

          const latestVer = await tx.queryOne<{ max_v: any }>(
            'SELECT MAX(version_number) as max_v FROM content_versions WHERE submission_id = $1 AND org_id = $2',
            [subId, auth.orgId]
          );
          const nextVer = Number(latestVer?.max_v || 1) + 1;

          await tx.query(
            `INSERT INTO content_versions (id, org_id, submission_id, version_number, content, created_by, change_summary, compliance_score, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'Re-analyzed draft', $7, $8)`,
            [`VER-${subId}-${nextVer}`, auth.orgId, subId, nextVer, cleanContent, auth.user.id, analysis!.compliance_score, now]
          );

          await tx.query('DELETE FROM compliance_issues WHERE submission_id = $1 AND org_id = $2', [
            subId,
            auth.orgId,
          ]);
        }

        for (let i = 0; i < analysis!.issues.length; i++) {
          const issue = analysis!.issues[i];
          const issueId = `ISS-${subId}-${i + 1}`;
          await tx.query(
            `INSERT INTO compliance_issues (id, org_id, submission_id, title, category, severity, problematic_text, explanation, source_guideline_id, source_document, supporting_guideline_excerpt, page_or_section, evidence_status, confidence_score, suggested_correction, confidence, human_status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'Pending', $17)`,
            [
              issueId,
              auth.orgId,
              subId,
              issue.title,
              issue.category,
              issue.severity,
              issue.problematic_text,
              issue.explanation,
              issue.source_guideline_id || null,
              issue.source_document || 'Brand Policy Standard',
              issue.supporting_guideline_excerpt || issue.explanation,
              issue.page_or_section || 'Brand Policy',
              issue.evidence_status || 'Unverified',
              Number(issue.confidence_score ?? 75),
              issue.suggested_correction,
              issue.confidence || 'High',
              now,
            ]
          );
        }
      });

      const savedSubmission = await db.queryOne(
        `SELECT s.*, u.name as author_name, om.role as author_role
         FROM submissions s
         JOIN users u ON s.created_by = u.id
         LEFT JOIN organisation_members om ON om.org_id = s.org_id AND om.user_id = s.created_by
         WHERE s.id = $1 AND s.org_id = $2`,
        [subId, auth.orgId]
      );
      const savedIssuesRes = await db.query(
        'SELECT * FROM compliance_issues WHERE submission_id = $1 AND org_id = $2 ORDER BY id ASC',
        [subId, auth.orgId]
      );

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'SUBMISSION_ANALYZED',
        entityType: 'submission',
        entityId: subId,
        details: {
          score: analysis.compliance_score,
          issueCount: savedIssuesRes.rows.length,
          usedAI,
          retrievedCount: retrieval.items.length,
          missingEvidenceWarning: retrieval.missing_evidence_warning,
        },
      });

      res.json({
        submission: savedSubmission,
        issues: savedIssuesRes.rows,
        compliance_score: analysis.compliance_score,
        overall_summary: analysis.overall_summary,
        used_ai: usedAI,
        retrieved_evidence: retrieval.items,
        retrieval_summary: {
          searched_chunks: retrieval.searched_chunks,
          searched_guidelines: retrieval.searched_guidelines,
          searched_facts: retrieval.searched_facts,
          searched_terminology: retrieval.searched_terminology,
          max_score: retrieval.max_score,
          missing_evidence_warning: retrieval.missing_evidence_warning,
          warning_message: retrieval.warning_message,
        },
      });
    })
  );

  app.get(
    '/api/submissions',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const result = await db.query(
        `SELECT s.*, u.name as author_name, COALESCE(om.role, u.role) as author_role,
           (SELECT COUNT(*) FROM compliance_issues ci WHERE ci.submission_id = s.id AND ci.org_id = s.org_id) as total_issues,
           (SELECT COUNT(*) FROM compliance_issues ci WHERE ci.submission_id = s.id AND ci.org_id = s.org_id AND ci.severity = 'High') as high_issues
         FROM submissions s
         JOIN users u ON s.created_by = u.id
         LEFT JOIN organisation_members om ON om.org_id = s.org_id AND om.user_id = s.created_by
         WHERE s.org_id = $1
         ORDER BY s.updated_at DESC`,
        [req.auth!.orgId]
      );
      res.json(
        result.rows.map((r: any) => ({
          ...r,
          total_issues: Number(r.total_issues ?? 0),
          high_issues: Number(r.high_issues ?? 0),
        }))
      );
    })
  );

  app.get(
    '/api/submissions/:id',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const { id } = req.params;
      const orgId = req.auth!.orgId;
      const submission = await db.queryOne(
        `SELECT s.*, u.name as author_name, COALESCE(om.role, u.role) as author_role
         FROM submissions s
         JOIN users u ON s.created_by = u.id
         LEFT JOIN organisation_members om ON om.org_id = s.org_id AND om.user_id = s.created_by
         WHERE s.id = $1 AND s.org_id = $2`,
        [id, orgId]
      );

      if (!submission) {
        return res.status(404).json({ error: 'Submission not found in your organisation.' });
      }

      const [issuesRes, reviewsRes, versionsRes, commentsRes, visualRes] = await Promise.all([
        db.query('SELECT * FROM compliance_issues WHERE submission_id = $1 AND org_id = $2 ORDER BY id ASC', [
          id,
          orgId,
        ]),
        db.query(
          `SELECT r.*, u.name as reviewer_name, COALESCE(om.role, u.role) as reviewer_role, u.avatar as reviewer_avatar
           FROM reviews r
           JOIN users u ON r.reviewer_id = u.id
           LEFT JOIN organisation_members om ON om.org_id = r.org_id AND om.user_id = r.reviewer_id
           WHERE r.submission_id = $1 AND r.org_id = $2
           ORDER BY r.created_at DESC`,
          [id, orgId]
        ),
        db.query(
          `SELECT cv.*, u.name as author_name
           FROM content_versions cv
           LEFT JOIN users u ON cv.created_by = u.id
           WHERE cv.submission_id = $1 AND cv.org_id = $2
           ORDER BY cv.version_number ASC`,
          [id, orgId]
        ),
        db.query(
          `SELECT sc.*, u.name as author_name, COALESCE(om.role, u.role) as author_role, u.avatar as author_avatar
           FROM submission_comments sc
           JOIN users u ON sc.author_id = u.id
           LEFT JOIN organisation_members om ON om.org_id = sc.org_id AND om.user_id = sc.author_id
           WHERE sc.submission_id = $1 AND sc.org_id = $2
           ORDER BY sc.created_at ASC`,
          [id, orgId]
        ),
        db.query(
          `SELECT va.*, a.asset_name as matched_logo_name, a.file_path as matched_logo_path
           FROM visual_analyses va
           LEFT JOIN assets a ON va.matched_logo_asset_id = a.id AND a.org_id = va.org_id
           WHERE va.submission_id = $1 AND va.org_id = $2
           ORDER BY va.created_at DESC`,
          [id, orgId]
        ),
      ]);

      const visual_analyses = visualRes.rows.map((v: any) => ({
        id: v.id,
        org_id: v.org_id,
        submission_id: v.submission_id,
        asset_name: v.asset_name,
        mime_type: v.mime_type,
        stored_file_id: v.stored_file_id,
        image_url: v.stored_file_id ? `/api/files/${v.stored_file_id}` : null,
        alt_text: v.alt_text,
        extracted_colors: JSON.parse(v.extracted_colors_json || '[]'),
        detected_fonts: JSON.parse(v.detected_fonts_json || '[]'),
        logo_similarity_score: v.logo_similarity_score,
        matched_logo_asset_id: v.matched_logo_asset_id,
        matched_logo_name: v.matched_logo_name || null,
        matched_logo_path: v.matched_logo_path || null,
        wcag_results: JSON.parse(v.wcag_results_json || '[]'),
        findings: JSON.parse(v.findings_json || '[]'),
        limitations: JSON.parse(v.limitations_json || '[]'),
        overall_score: Number(v.overall_score ?? 100),
        created_at: v.created_at,
      }));

      res.json({
        submission,
        issues: issuesRes.rows,
        reviews: reviewsRes.rows,
        versions: versionsRes.rows,
        comments: commentsRes.rows,
        visual_analyses,
      });
    })
  );

  // -------------------------------------------------------------
  // VISUAL BRAND GOVERNANCE & WCAG ACCESSIBILITY ANALYSIS
  // -------------------------------------------------------------
  app.get(
    '/api/visual/analyses',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const submissionId = req.query.submission_id ? String(req.query.submission_id) : null;
      const sql = submissionId
        ? `SELECT va.*, a.asset_name as matched_logo_name, a.file_path as matched_logo_path
           FROM visual_analyses va
           LEFT JOIN assets a ON va.matched_logo_asset_id = a.id AND a.org_id = va.org_id
           WHERE va.org_id = $1 AND va.submission_id = $2
           ORDER BY va.created_at DESC`
        : `SELECT va.*, a.asset_name as matched_logo_name, a.file_path as matched_logo_path
           FROM visual_analyses va
           LEFT JOIN assets a ON va.matched_logo_asset_id = a.id AND a.org_id = va.org_id
           WHERE va.org_id = $1
           ORDER BY va.created_at DESC
           LIMIT 30`;
      const result = await db.query(sql, submissionId ? [auth.orgId, submissionId] : [auth.orgId]);

      res.json({
        analyses: result.rows.map((v: any) => ({
          id: v.id,
          org_id: v.org_id,
          submission_id: v.submission_id,
          asset_name: v.asset_name,
          mime_type: v.mime_type,
          stored_file_id: v.stored_file_id,
          image_url: v.stored_file_id ? `/api/files/${v.stored_file_id}` : null,
          alt_text: v.alt_text,
          extracted_colors: JSON.parse(v.extracted_colors_json || '[]'),
          detected_fonts: JSON.parse(v.detected_fonts_json || '[]'),
          logo_similarity_score: v.logo_similarity_score,
          matched_logo_asset_id: v.matched_logo_asset_id,
          matched_logo_name: v.matched_logo_name || null,
          matched_logo_path: v.matched_logo_path || null,
          wcag_results: JSON.parse(v.wcag_results_json || '[]'),
          findings: JSON.parse(v.findings_json || '[]'),
          limitations: JSON.parse(v.limitations_json || '[]'),
          overall_score: Number(v.overall_score ?? 100),
          created_at: v.created_at,
        })),
      });
    })
  );

  app.post(
    '/api/visual/analyze',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { fileBase64, fileName, mimeType, altText, htmlOrCss, foregroundHex, backgroundHex, submissionId } =
        req.body || {};

      if (submissionId) {
        const sub = await db.queryOne('SELECT id FROM submissions WHERE id = $1 AND org_id = $2', [
          String(submissionId),
          auth.orgId,
        ]);
        if (!sub) {
          return res.status(404).json({ error: 'Linked submission not found in your organisation.' });
        }
      }

      const fileBuffer = fileBase64 ? Buffer.from(String(fileBase64), 'base64') : undefined;
      const analysis = await runVisualGovernanceAnalysis({
        db,
        storage,
        orgId: auth.orgId,
        userId: auth.user.id,
        submissionId: submissionId ? String(submissionId) : null,
        fileBuffer,
        fileName: fileName ? String(fileName) : undefined,
        mimeType: mimeType ? String(mimeType) : undefined,
        altText: altText !== undefined ? String(altText) : undefined,
        htmlOrCss: htmlOrCss ? String(htmlOrCss) : undefined,
        foregroundHex: foregroundHex ? String(foregroundHex) : undefined,
        backgroundHex: backgroundHex ? String(backgroundHex) : undefined,
      });

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'VISUAL_ANALYSIS_COMPLETED',
        entityType: 'visual_analysis',
        entityId: analysis.id,
        details: {
          assetName: analysis.asset_name,
          overallScore: analysis.overall_score,
          logoSimilarity: analysis.logo_similarity_score,
          findingsCount: analysis.findings.length,
        },
      });

      res.status(201).json({ analysis });
    })
  );

  app.patch(
    '/api/visual/analyses/:id/alt-text',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const cleanAlt = String(req.body?.altText || '').trim();
      const existing = await db.queryOne<any>(
        'SELECT * FROM visual_analyses WHERE id = $1 AND org_id = $2',
        [req.params.id, auth.orgId]
      );
      if (!existing) {
        return res.status(404).json({ error: 'Visual analysis record not found in your organisation.' });
      }

      let findings = JSON.parse(existing.findings_json || '[]') as any[];
      // Remove previous alt-text finding and re-evaluate cleanly
      findings = findings.filter((f) => f.category !== 'Accessibility');
      if (!cleanAlt) {
        findings.push({
          id: `VF-ALT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          category: 'Accessibility',
          severity: 'High',
          title: 'Missing Descriptive Image Alt Text',
          explanation: 'Uploaded visual creative has empty alt text.',
          suggested_fix: 'Provide descriptive alternative text for screen readers.',
          evidence: 'alt_text=""',
        });
      } else if (cleanAlt.length < 8 || /\.(png|jpe?g|webp|svg|gif)$/i.test(cleanAlt)) {
        findings.push({
          id: `VF-ALT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          category: 'Accessibility',
          severity: 'Medium',
          title: 'Insufficient Image Alt Text',
          explanation: `Provided alt text "${cleanAlt}" is too short or filename-like.`,
          suggested_fix: 'Write a descriptive sentence describing image content.',
          evidence: `alt_text="${cleanAlt}"`,
        });
      }

      let overallScore = 100;
      for (const f of findings) {
        if (f.severity === 'High') overallScore -= 24;
        else if (f.severity === 'Medium') overallScore -= 14;
        else overallScore -= 6;
      }
      overallScore = Math.max(10, Math.min(100, overallScore));

      await db.query(
        'UPDATE visual_analyses SET alt_text = $1, findings_json = $2, overall_score = $3 WHERE id = $4 AND org_id = $5',
        [cleanAlt, JSON.stringify(findings), overallScore, req.params.id, auth.orgId]
      );

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'VISUAL_ALT_TEXT_UPDATED',
        entityType: 'visual_analysis',
        entityId: req.params.id,
        details: { altLength: cleanAlt.length, overallScore },
      });

      res.json({
        success: true,
        id: req.params.id,
        alt_text: cleanAlt,
        findings,
        overall_score: overallScore,
      });
    })
  );

  app.patch(
    '/api/submissions/:id/content',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id } = req.params;
      const { content, compliance_score, change_summary } = req.body || {};
      if (content === undefined) {
        return res.status(400).json({ error: 'Content is required.' });
      }

      const sub = await db.queryOne<any>('SELECT * FROM submissions WHERE id = $1 AND org_id = $2', [id, auth.orgId]);

      if (!sub) {
        return res.status(404).json({ error: 'Submission not found in your organisation.' });
      }
      if (sub.created_by !== auth.user.id && auth.role !== 'admin') {
        return res.status(403).json({
          error: 'Forbidden: Only the submission creator or an Administrator may modify this draft.',
        });
      }
      if (!['Draft', 'Needs Revision'].includes(sub.status)) {
        return res.status(400).json({ error: `Cannot edit content while status is "${sub.status}".` });
      }

      const now = new Date().toISOString();
      let nextScore = compliance_score;
      if (nextScore === undefined || nextScore === null) {
        const [guidelinesRes, factsRes, terminologyRes] = await Promise.all([
          db.query('SELECT * FROM guidelines WHERE org_id = $1', [auth.orgId]),
          db.query('SELECT * FROM approved_facts WHERE org_id = $1', [auth.orgId]),
          db.query('SELECT * FROM terminology WHERE org_id = $1', [auth.orgId]),
        ]);
        nextScore = analyzeWithRuleEngine(
          String(content),
          sub.content_type,
          guidelinesRes.rows,
          factsRes.rows,
          terminologyRes.rows
        ).compliance_score;
      }

      let nextVer = 2;
      await db.transaction(async (tx) => {
        const latestVer = await tx.queryOne<{ max_v: any }>(
          'SELECT MAX(version_number) as max_v FROM content_versions WHERE submission_id = $1 AND org_id = $2',
          [id, auth.orgId]
        );
        nextVer = Number(latestVer?.max_v || 1) + 1;

        await tx.query(
          `INSERT INTO content_versions (id, org_id, submission_id, version_number, content, created_by, change_summary, compliance_score, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            `VER-${id}-${nextVer}`,
            auth.orgId,
            id,
            nextVer,
            String(content),
            auth.user.id,
            change_summary || 'Creator revision applied',
            nextScore,
            now,
          ]
        );

        await tx.query(
          `UPDATE submissions
           SET content = $1, compliance_score = $2, updated_at = $3
           WHERE id = $4 AND org_id = $5`,
          [String(content), nextScore, now, id, auth.orgId]
        );
      });

      const updated = await db.queryOne('SELECT * FROM submissions WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'SUBMISSION_CONTENT_UPDATED',
        entityType: 'submission',
        entityId: id,
        details: { version: nextVer, compliance_score: nextScore },
      });

      res.json({ success: true, submission: updated, version_number: nextVer });
    })
  );

  app.patch(
    '/api/submissions/:id/issue/:issueId',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id, issueId } = req.params;
      const { human_status, suggested_correction } = req.body || {};

      const sub = await db.queryOne<any>('SELECT id, created_by, status FROM submissions WHERE id = $1 AND org_id = $2', [
        id,
        auth.orgId,
      ]);

      if (!sub) {
        return res.status(404).json({ error: 'Submission not found in your organisation.' });
      }
      if (sub.created_by !== auth.user.id && auth.role !== 'admin') {
        return res.status(403).json({
          error: 'Forbidden: Only the submission creator or an Administrator may update issue status.',
        });
      }

      const result = await db.query(
        `UPDATE compliance_issues
         SET human_status = COALESCE($1, human_status),
             suggested_correction = COALESCE($2, suggested_correction)
         WHERE id = $3 AND submission_id = $4 AND org_id = $5`,
        [human_status || null, suggested_correction || null, issueId, id, auth.orgId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Issue not found in your organisation.' });
      }

      const updated = await db.queryOne('SELECT * FROM compliance_issues WHERE id = $1 AND org_id = $2', [
        issueId,
        auth.orgId,
      ]);
      res.json(updated);
    })
  );

  app.post(
    '/api/submissions/:id/submit-review',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id } = req.params;
      const sub = await db.queryOne<{ id: string; created_by: string; status: string }>(
        'SELECT id, created_by, status FROM submissions WHERE id = $1 AND org_id = $2',
        [id, auth.orgId]
      );

      if (!sub) {
        return res.status(404).json({ error: 'Submission not found in your organisation.' });
      }
      if (sub.created_by !== auth.user.id && auth.role !== 'admin') {
        return res.status(403).json({
          error: 'Forbidden: Only the submission creator or an Administrator may submit for review.',
        });
      }
      if (!['Draft', 'Needs Revision'].includes(sub.status)) {
        return res.status(400).json({ error: `Cannot submit for review from "${sub.status}" status.` });
      }

      const now = new Date().toISOString();
      await db.query("UPDATE submissions SET status = 'In Review', updated_at = $1 WHERE id = $2 AND org_id = $3", [
        now,
        id,
        auth.orgId,
      ]);

      const updated = await db.queryOne('SELECT * FROM submissions WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'SUBMISSION_SUBMITTED_FOR_REVIEW',
        entityType: 'submission',
        entityId: id,
      });

      res.json({ success: true, submission: updated });
    })
  );

  app.post(
    '/api/submissions/:id/review',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { id } = req.params;
      const { decision, comments } = req.body || {};

      if (!['Approved', 'Rejected', 'Needs Revision'].includes(decision)) {
        return res.status(400).json({ error: 'Valid decision (Approved, Rejected, Needs Revision) required.' });
      }

      const sub = await db.queryOne<{ id: string; created_by: string; status: string }>(
        'SELECT id, created_by, status FROM submissions WHERE id = $1 AND org_id = $2',
        [id, auth.orgId]
      );

      if (!sub) {
        return res.status(404).json({ error: 'Submission not found in your organisation.' });
      }

      if (sub.created_by === auth.user.id) {
        return res.status(403).json({
          error: 'Self-approval is prohibited: Reviewers cannot approve or reject their own submissions.',
        });
      }

      if (sub.status !== 'In Review') {
        return res.status(400).json({
          error: `Submission must be in "In Review" status before review sign-off (current: "${sub.status}").`,
        });
      }

      const cleanComments = String(comments || '').trim();
      if ((decision === 'Rejected' || decision === 'Needs Revision') && !cleanComments) {
        return res.status(400).json({ error: 'Audit rationale comments are required when rejecting or requesting revision.' });
      }

      const now = new Date().toISOString();
      const reviewId = `REV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO reviews (id, org_id, submission_id, reviewer_id, decision, comments, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [reviewId, auth.orgId, id, auth.user.id, decision, cleanComments, now]
        );

        await tx.query('UPDATE submissions SET status = $1, updated_at = $2 WHERE id = $3 AND org_id = $4', [
          decision,
          now,
          id,
          auth.orgId,
        ]);
      });

      const updated = await db.queryOne('SELECT * FROM submissions WHERE id = $1 AND org_id = $2', [id, auth.orgId]);
      const reviewsRes = await db.query(
        `SELECT r.*, u.name as reviewer_name, COALESCE(om.role, u.role) as reviewer_role
         FROM reviews r
         JOIN users u ON r.reviewer_id = u.id
         LEFT JOIN organisation_members om ON om.org_id = r.org_id AND om.user_id = r.reviewer_id
         WHERE r.submission_id = $1 AND r.org_id = $2
         ORDER BY r.created_at DESC`,
        [id, auth.orgId]
      );

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'SUBMISSION_REVIEWED',
        entityType: 'submission',
        entityId: id,
        details: { decision, reviewId },
      });

      res.json({ success: true, submission: updated, reviews: reviewsRes.rows });
    })
  );

  // -------------------------------------------------------------
  // COLLABORATION: THREADED COMMENTS
  // -------------------------------------------------------------
  app.get(
    '/api/submissions/:id/comments',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const sub = await db.queryOne('SELECT id FROM submissions WHERE id = $1 AND org_id = $2', [
        req.params.id,
        auth.orgId,
      ]);
      if (!sub) {
        return res.status(404).json({ error: 'Submission not found in your organisation.' });
      }

      const commentsRes = await db.query(
        `SELECT sc.*, u.name as author_name, COALESCE(om.role, u.role) as author_role, u.avatar as author_avatar
         FROM submission_comments sc
         JOIN users u ON sc.author_id = u.id
         LEFT JOIN organisation_members om ON om.org_id = sc.org_id AND om.user_id = sc.author_id
         WHERE sc.submission_id = $1 AND sc.org_id = $2
         ORDER BY sc.created_at ASC`,
        [req.params.id, auth.orgId]
      );

      res.json({ comments: commentsRes.rows });
    })
  );

  app.post(
    '/api/submissions/:id/comments',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const { body, issue_id } = req.body || {};
      const cleanBody = String(body || '').trim();
      if (!cleanBody) {
        return res.status(400).json({ error: 'Comment text is required.' });
      }

      const sub = await db.queryOne('SELECT id FROM submissions WHERE id = $1 AND org_id = $2', [
        req.params.id,
        auth.orgId,
      ]);
      if (!sub) {
        return res.status(404).json({ error: 'Submission not found in your organisation.' });
      }

      const commentId = `CMT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO submission_comments (id, org_id, submission_id, issue_id, author_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [commentId, auth.orgId, req.params.id, issue_id || null, auth.user.id, cleanBody, now]
      );

      const created = await db.queryOne(
        `SELECT sc.*, u.name as author_name, COALESCE(om.role, u.role) as author_role, u.avatar as author_avatar
         FROM submission_comments sc
         JOIN users u ON sc.author_id = u.id
         LEFT JOIN organisation_members om ON om.org_id = sc.org_id AND om.user_id = sc.author_id
         WHERE sc.id = $1 AND sc.org_id = $2`,
        [commentId, auth.orgId]
      );

      await recordAuditLog(db, {
        orgId: auth.orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'COMMENT_ADDED',
        entityType: 'submission',
        entityId: req.params.id,
        details: { commentId, issueId: issue_id || null },
      });

      res.status(201).json({ comment: created });
    })
  );

  // -------------------------------------------------------------
  // AUDIT LOGS (BRAND MANAGER & ADMIN ONLY, ORG-ISOLATED)
  // -------------------------------------------------------------
  app.get(
    '/api/audit-logs',
    requireAuth,
    requireOrgContext,
    requireOrgRole('brand_manager', 'admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
      const result = await db.query(
        `SELECT a.*, u.name as actor_name, u.email as actor_email
         FROM audit_logs a
         LEFT JOIN users u ON a.actor_id = u.id
         WHERE a.org_id = $1
         ORDER BY a.created_at DESC
         LIMIT $2`,
        [auth.orgId, limit]
      );
      res.json({
        logs: result.rows.map((l: any) => ({
          ...l,
          details: typeof l.details === 'string' ? l.details : JSON.stringify(l.details || {}),
        })),
      });
    })
  );

  // -------------------------------------------------------------
  // GOVERNANCE ANALYTICS (ORG-ISOLATED REAL QUERIES)
  // -------------------------------------------------------------
  app.get(
    '/api/analytics',
    requireAuth,
    requireOrgContext,
    asyncHandler(async (req: AuthRequest, res) => {
      const orgId = req.auth!.orgId;

      const [
        totalRow,
        approvedRow,
        rejectedRow,
        inReviewRow,
        needsRevisionRow,
        totalIssuesRow,
        issuesByCategoryRes,
        issuesBySeverityRes,
        topViolatedRulesRes,
        repeatedTerminologyRes,
        monthlyTrendsRes,
      ] = await Promise.all([
        db.queryOne<{ count: any }>('SELECT COUNT(*) as count FROM submissions WHERE org_id = $1', [orgId]),
        db.queryOne<{ count: any }>("SELECT COUNT(*) as count FROM submissions WHERE org_id = $1 AND status = 'Approved'", [
          orgId,
        ]),
        db.queryOne<{ count: any }>("SELECT COUNT(*) as count FROM submissions WHERE org_id = $1 AND status = 'Rejected'", [
          orgId,
        ]),
        db.queryOne<{ count: any }>("SELECT COUNT(*) as count FROM submissions WHERE org_id = $1 AND status = 'In Review'", [
          orgId,
        ]),
        db.queryOne<{ count: any }>(
          "SELECT COUNT(*) as count FROM submissions WHERE org_id = $1 AND status = 'Needs Revision'",
          [orgId]
        ),
        db.queryOne<{ count: any }>('SELECT COUNT(*) as count FROM compliance_issues WHERE org_id = $1', [orgId]),
        db.query(
          `SELECT category, COUNT(*) as count
           FROM compliance_issues
           WHERE org_id = $1
           GROUP BY category
           ORDER BY count DESC`,
          [orgId]
        ),
        db.query(
          `SELECT severity, COUNT(*) as count
           FROM compliance_issues
           WHERE org_id = $1
           GROUP BY severity`,
          [orgId]
        ),
        db.query(
          `SELECT g.id, g.title, g.category, COUNT(ci.id) as violations
           FROM guidelines g
           LEFT JOIN compliance_issues ci ON ci.source_guideline_id = g.id AND ci.org_id = g.org_id
           WHERE g.org_id = $1
           GROUP BY g.id, g.title, g.category
           ORDER BY violations DESC
           LIMIT 6`,
          [orgId]
        ),
        db.query(
          `SELECT LOWER(TRIM(problematic_text)) as term, COUNT(*) as count, MAX(suggested_correction) as preferred
           FROM compliance_issues
           WHERE org_id = $1 AND category = 'Terminology'
           GROUP BY LOWER(TRIM(problematic_text))
           ORDER BY count DESC
           LIMIT 5`,
          [orgId]
        ),
        db.query(
          `SELECT substr(CAST(created_at AS TEXT), 1, 7) as month,
                  COUNT(*) as submissions,
                  ROUND(AVG(compliance_score), 1) as avg_score
           FROM submissions
           WHERE org_id = $1
           GROUP BY substr(CAST(created_at AS TEXT), 1, 7)
           ORDER BY month ASC`,
          [orgId]
        ),
      ]);

      const totalCount = Number(totalRow?.count ?? 0);
      const approvedCount = Number(approvedRow?.count ?? 0);
      const rejectedCount = Number(rejectedRow?.count ?? 0);
      const inReviewCount = Number(inReviewRow?.count ?? 0);
      const needsRevisionCount = Number(needsRevisionRow?.count ?? 0);
      const totalIssuesCount = Number(totalIssuesRow?.count ?? 0);

      const submissionsByStatus = [
        { name: 'Approved', count: approvedCount, color: '#0D9488' },
        { name: 'In Review', count: inReviewCount, color: '#3B82F6' },
        { name: 'Needs Revision', count: needsRevisionCount, color: '#F59E0B' },
        { name: 'Rejected', count: rejectedCount, color: '#EF4444' },
        {
          name: 'Draft',
          count: Math.max(0, totalCount - (approvedCount + inReviewCount + needsRevisionCount + rejectedCount)),
          color: '#64748B',
        },
      ];

      const topViolatedRules = topViolatedRulesRes.rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        violations: Number(r.violations ?? 0),
      }));

      const unclearGuidelines = topViolatedRules.filter((r) => r.violations >= 2);

      res.json({
        metrics: {
          totalSubmissions: totalCount,
          approvedSubmissions: approvedCount,
          rejectedSubmissions: rejectedCount,
          pendingReviews: inReviewCount,
          needsRevision: needsRevisionCount,
          totalIssues: totalIssuesCount,
        },
        submissionsByStatus,
        issuesByCategory: issuesByCategoryRes.rows.map((r: any) => ({
          category: r.category,
          count: Number(r.count ?? 0),
        })),
        issuesBySeverity: issuesBySeverityRes.rows.map((r: any) => ({
          severity: r.severity,
          count: Number(r.count ?? 0),
        })),
        topViolatedRules,
        repeatedTerminology: repeatedTerminologyRes.rows.map((r: any) => ({
          term: r.term,
          count: Number(r.count ?? 0),
          preferred: r.preferred,
        })),
        unclearGuidelines,
        monthlyTrends: monthlyTrendsRes.rows.map((r: any) => ({
          month: r.month,
          submissions: Number(r.submissions ?? 0),
          avgScore: Number(r.avg_score ?? 0),
        })),
      });
    })
  );

  // -------------------------------------------------------------
  // WORKSPACE STARTER RESET (ADMIN ONLY, SCOPED TO ACTIVE ORG ONLY)
  // -------------------------------------------------------------
  app.post(
    '/api/reset-demo',
    requireAuth,
    requireOrgContext,
    requireOrgRole('admin'),
    asyncHandler(async (req: AuthRequest, res) => {
      const auth = req.auth!;
      const orgId = auth.orgId;

      await db.transaction(async (tx) => {
        await tx.query('DELETE FROM submission_comments WHERE org_id = $1', [orgId]);
        await tx.query('DELETE FROM reviews WHERE org_id = $1', [orgId]);
        await tx.query('DELETE FROM content_versions WHERE org_id = $1', [orgId]);
        await tx.query('DELETE FROM compliance_issues WHERE org_id = $1', [orgId]);
        await tx.query('DELETE FROM submissions WHERE org_id = $1', [orgId]);
        await tx.query('DELETE FROM assets WHERE org_id = $1', [orgId]);
        await tx.query('DELETE FROM terminology WHERE org_id = $1', [orgId]);
        await tx.query('DELETE FROM approved_facts WHERE org_id = $1', [orgId]);
        await tx.query('DELETE FROM guidelines WHERE org_id = $1', [orgId]);
      });

      await seedStarterWorkspaceForOrg(db, orgId, auth.user.id, auth.org.name);

      await recordAuditLog(db, {
        orgId,
        actorId: auth.user.id,
        actorRole: auth.role,
        action: 'WORKSPACE_STARTER_RESET',
        entityType: 'organisation',
        entityId: orgId,
      });

      res.json({
        success: true,
        message: `${auth.org.name} brand governance workspace reset to starter template.`,
      });
    })
  );

  // Centralized error handler (maps DB/storage outages to 503 and validation/duplicate errors cleanly)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DocumentValidationError || err instanceof VisualValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof DuplicateDocumentError) {
      return res.status(409).json({ error: err.message, existingDocumentId: err.existingDocumentId });
    }
    if (err instanceof DatabaseUnavailableError || err instanceof StorageUnavailableError) {
      console.error(`${err.name}:`, err.message);
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof ConfigurationError) {
      console.error('ConfigurationError:', err.message);
      return res.status(500).json({ error: 'Server configuration error.' });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON request payload.' });
    }
    console.error('Unhandled API error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return { app, db, storage };
}
