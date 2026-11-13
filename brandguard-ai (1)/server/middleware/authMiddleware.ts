import { Request, Response, NextFunction } from 'express';
import { DbAdapter } from '../db/types.js';
import {
  logAuthDiagnostic,
  parseCookieValue,
  resolveSessionDetailed,
  SESSION_COOKIE_NAME,
} from '../services/authService.js';
import { DatabaseUnavailableError } from '../errors.js';

export type OrgRole = 'creator' | 'brand_manager' | 'admin';

export interface AuthenticatedContext {
  sessionId: string;
  rawToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
  };
  orgId: string;
  org: {
    id: string;
    name: string;
    slug: string;
    brand_settings: string;
  };
  role: OrgRole;
}

export interface AuthRequest extends Request {
  auth?: AuthenticatedContext;
  sessionOnly?: {
    sessionId: string;
    rawToken: string;
    activeOrgId: string;
    user: {
      id: string;
      name: string;
      email: string;
      avatar: string | null;
    };
  };
}

export function extractRawToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer) return bearer;
  }
  return parseCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
}

export function createAuthMiddleware(db: DbAdapter) {
  const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const rawToken = extractRawToken(req);
      if (!rawToken) {
        if (process.env.AUTH_DEBUG_LOGS === 'true') {
          logAuthDiagnostic('unauthenticated_request', {
            reason: 'missing_cookie',
            path: req.path,
            hasCookieHeader: Boolean(req.headers.cookie),
            clientContext: req.header('x-client-context') || 'unknown',
          });
        }
        return res.status(401).json({ error: 'Authentication required. Please sign in.' });
      }

      const lookup = await resolveSessionDetailed(db, rawToken);
      if (!lookup.session) {
        logAuthDiagnostic('session_lookup_failed', {
          reason: lookup.reason || 'invalid',
          path: req.path,
        });
        return res.status(401).json({ error: 'Session is invalid or expired. Please sign in again.' });
      }

      req.sessionOnly = {
        sessionId: lookup.session.sessionId,
        rawToken,
        activeOrgId: lookup.session.activeOrgId,
        user: {
          id: lookup.session.user.id,
          name: lookup.session.user.name,
          email: lookup.session.user.email,
          avatar: lookup.session.user.avatar,
        },
      };

      next();
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) {
        return res.status(503).json({ error: err.message });
      }
      console.error('Auth verification error:', err);
      return res.status(500).json({ error: 'Authentication verification failed.' });
    }
  };

  const requireOrgContext = async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.sessionOnly) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    try {
      const requestedOrgId = (req.header('x-org-id') || '').trim() || req.sessionOnly.activeOrgId;
      const membership = await db.queryOne<any>(
        `SELECT om.role, o.id, o.name, o.slug, o.brand_settings
         FROM organisation_members om
         JOIN organisations o ON o.id = om.org_id
         WHERE om.org_id = $1 AND om.user_id = $2`,
        [requestedOrgId, req.sessionOnly.user.id]
      );

      if (!membership) {
        logAuthDiagnostic('org_context_denied', {
          userId: req.sessionOnly.user.id,
          requestedOrgId,
          path: req.path,
        });
        return res.status(403).json({
          error: 'Forbidden: You do not belong to the requested organisation.',
        });
      }

      req.auth = {
        sessionId: req.sessionOnly.sessionId,
        rawToken: req.sessionOnly.rawToken,
        user: req.sessionOnly.user,
        orgId: membership.id,
        org: {
          id: membership.id,
          name: membership.name,
          slug: membership.slug,
          brand_settings:
            typeof membership.brand_settings === 'string'
              ? membership.brand_settings
              : JSON.stringify(membership.brand_settings || {}),
        },
        role: membership.role as OrgRole,
      };

      next();
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) {
        return res.status(503).json({ error: err.message });
      }
      console.error('Organisation scope verification error:', err);
      return res.status(500).json({ error: 'Failed to verify organisation membership.' });
    }
  };

  const requireOrgRole = (...allowedRoles: OrgRole[]) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
      if (!req.auth) {
        return res.status(401).json({ error: 'Authentication and organisation context required.' });
      }
      if (!allowedRoles.includes(req.auth.role)) {
        return res.status(403).json({
          error: `Forbidden: Requires ${allowedRoles.map((r) => r.replace('_', ' ')).join(' or ')} role.`,
        });
      }
      next();
    };
  };

  return { requireAuth, requireOrgContext, requireOrgRole };
}
