import crypto from 'crypto';
import { DbClient } from '../db/types.js';

export interface AuditEventInput {
  orgId: string;
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

export async function recordAuditLog(db: DbClient, input: AuditEventInput): Promise<void> {
  try {
    const id = `AUD-${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO audit_logs (id, org_id, actor_id, actor_role, action, entity_type, entity_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        id,
        input.orgId,
        input.actorId ?? null,
        input.actorRole ?? null,
        input.action,
        input.entityType,
        input.entityId ?? null,
        JSON.stringify(input.details || {}),
        now,
      ]
    );
  } catch (err) {
    console.error('Audit log write failed:', err);
  }
}
