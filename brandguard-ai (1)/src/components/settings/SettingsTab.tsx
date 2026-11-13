import React, { useState, useEffect, useCallback } from 'react';
import {
  Settings,
  Users,
  Shield,
  RefreshCw,
  Building2,
  Lock,
  Layers,
  CheckCircle2,
  Cpu,
  UserPlus,
  History,
  PlusCircle,
  AlertCircle,
} from 'lucide-react';
import { User, UserRole, OrgMembership, OrgMember, AuditLogEntry } from '../../types';
import { api } from '../../services/api';

interface SettingsProps {
  currentUser: User | null;
  activeOrg: OrgMembership | null;
  memberships: OrgMembership[];
  onCreateOrg: (name: string, seedStarterBrand?: boolean) => Promise<void>;
  onSwitchOrg: (orgId: string) => Promise<void>;
  onRequestResetDemo: () => void;
  isResetting?: boolean;
}

const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  creator: 'Submit copy, upload creatives, run compliance scans, apply suggestions, collaborate via comments, and submit for approval.',
  brand_manager: 'Manage brand guidelines, approved facts, terminology, assets, and RAG policy documents; approve or reject peer submissions and inspect audit logs.',
  admin: 'Full administrative control: manage organisation brand palette & fonts, provision members, assign roles, and manage workspace resets.',
};

export const SettingsTab: React.FC<SettingsProps> = ({
  currentUser,
  activeOrg,
  memberships,
  onCreateOrg,
  onSwitchOrg,
  onRequestResetDemo,
  isResetting = false,
}) => {
  const userRole: UserRole = activeOrg?.role || currentUser?.role || 'creator';
  const isAdmin = userRole === 'admin';
  const canViewAuditLogs = userRole === 'admin' || userRole === 'brand_manager';

  // Team members state
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberSuccess, setMemberSuccess] = useState<string | null>(null);

  // Add member form state
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberPassword, setNewMemberPassword] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<UserRole>('creator');
  const [addingMember, setAddingMember] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  // Create org form state
  const [newOrgName, setNewOrgName] = useState('');
  const [seedStarterBrand, setSeedStarterBrand] = useState(true);
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    if (!activeOrg?.orgId) return;
    setMembersLoading(true);
    setMemberError(null);
    try {
      const res = await api.getOrgMembers(activeOrg.orgId);
      setMembers(res.members);
    } catch (err: any) {
      setMemberError(err?.message || 'Failed to load organisation members');
    } finally {
      setMembersLoading(false);
    }
  }, [activeOrg?.orgId]);

  const loadAuditLogs = useCallback(async () => {
    if (!activeOrg?.orgId || !canViewAuditLogs) {
      setAuditLogs([]);
      return;
    }
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await api.getAuditLogs(100);
      setAuditLogs(res.logs);
    } catch (err: any) {
      setAuditError(err?.message || 'Failed to load audit logs');
    } finally {
      setAuditLoading(false);
    }
  }, [activeOrg?.orgId, canViewAuditLogs]);

  useEffect(() => {
    loadMembers();
    loadAuditLogs();
  }, [loadMembers, loadAuditLogs]);

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrg?.orgId) return;
    setMemberError(null);
    setMemberSuccess(null);

    if (newMemberPassword.length < 8) {
      setMemberError('Password must be at least 8 characters long.');
      return;
    }

    setAddingMember(true);
    try {
      await api.addOrgMember(activeOrg.orgId, {
        name: newMemberName.trim(),
        email: newMemberEmail.trim(),
        password: newMemberPassword,
        role: newMemberRole,
      });
      setNewMemberName('');
      setNewMemberEmail('');
      setNewMemberPassword('');
      setNewMemberRole('creator');
      setMemberSuccess('Team member added to organisation workspace.');
      await Promise.all([loadMembers(), loadAuditLogs()]);
    } catch (err: any) {
      setMemberError(err?.message || 'Unable to add team member.');
    } finally {
      setAddingMember(false);
    }
  };

  const handleRoleChange = async (userId: string, role: UserRole) => {
    if (!activeOrg?.orgId) return;
    setMemberError(null);
    setMemberSuccess(null);
    setUpdatingUserId(userId);
    try {
      await api.updateOrgMemberRole(activeOrg.orgId, userId, role);
      setMemberSuccess('Member role updated.');
      await Promise.all([loadMembers(), loadAuditLogs()]);
    } catch (err: any) {
      setMemberError(err?.message || 'Unable to update member role.');
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    setOrgError(null);
    if (!newOrgName.trim()) {
      setOrgError('Organisation name is required.');
      return;
    }
    setCreatingOrg(true);
    try {
      await onCreateOrg(newOrgName.trim(), seedStarterBrand);
      setNewOrgName('');
    } catch (err: any) {
      setOrgError(err?.message || 'Failed to create organisation.');
    } finally {
      setCreatingOrg(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Settings className="w-5 h-5 text-teal-600" />
            <span>Organisation Security, Team & Governance Settings</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Active tenant: <span className="font-semibold text-slate-700">{activeOrg?.name}</span> · Your role:{' '}
            <span className="font-mono uppercase font-semibold text-teal-700">{userRole.replace('_', ' ')}</span>
          </p>
        </div>

        {isAdmin && (
          <button
            onClick={onRequestResetDemo}
            disabled={isResetting}
            className="px-3.5 py-2 text-xs font-semibold bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isResetting ? 'animate-spin' : ''}`} />
            <span>Reset Starter Data</span>
          </button>
        )}
      </div>

      {/* Organisation Workspace Isolation Manager */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-teal-600" />
              <span>Organisation Workspaces & Tenant Isolation</span>
            </h3>
            <p className="text-xs text-slate-500">
              Each organisation maintains completely isolated guidelines, facts, assets, submissions, and audit logs.
            </p>
          </div>
          <span className="text-[11px] font-mono text-slate-500 bg-slate-100 px-2.5 py-1 rounded">
            Org ID: {activeOrg?.orgId}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-700">Your Organisation Memberships</div>
            <div className="space-y-2">
              {memberships.map((m) => {
                const isActive = m.orgId === activeOrg?.orgId;
                return (
                  <div
                    key={m.orgId}
                    className={`p-3 rounded-lg border flex items-center justify-between ${
                      isActive ? 'border-teal-500 bg-teal-50/30' : 'border-slate-200 bg-slate-50/60'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-bold text-slate-900 flex items-center gap-2">
                        <span>{m.name}</span>
                        {isActive && (
                          <span className="text-[10px] font-semibold text-teal-700 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Active
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        Role: {m.role.replace('_', ' ')} · {m.slug}
                      </div>
                    </div>
                    {!isActive && (
                      <button
                        onClick={() => onSwitchOrg(m.orgId)}
                        className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 hover:bg-slate-100 rounded-md text-slate-800 transition-colors"
                      >
                        Switch
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <form onSubmit={handleCreateOrg} className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
            <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <PlusCircle className="w-3.5 h-3.5 text-teal-600" />
              <span>Create New Isolated Organisation</span>
            </div>
            {orgError && (
              <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-700 text-xs">{orgError}</div>
            )}
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Organisation Name</label>
              <input
                type="text"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder="e.g., Meridian Financial Group"
                className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={seedStarterBrand}
                onChange={(e) => setSeedStarterBrand(e.target.checked)}
                className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              <span>Initialize with starter brand guidelines & sample content</span>
            </label>
            <button
              type="submit"
              disabled={creatingOrg}
              className="px-3.5 py-2 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {creatingOrg ? 'Creating Workspace...' : 'Create & Switch Workspace'}
            </button>
          </form>
        </div>
      </div>

      {/* Team & Role Governance (RBAC) */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Users className="w-4 h-4 text-teal-600" />
              <span>Team Members & Enforced RBAC Permissions</span>
            </h3>
            <p className="text-xs text-slate-500">
              Server-enforced Creator, Brand Manager, and Administrator access control for {activeOrg?.name}
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500">{members.length} members</span>
        </div>

        {memberError && (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{memberError}</span>
          </div>
        )}
        {memberSuccess && (
          <div className="p-3 rounded-lg bg-teal-50 border border-teal-200 text-teal-800 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{memberSuccess}</span>
          </div>
        )}

        {membersLoading ? (
          <div className="text-xs text-slate-500 py-4">Loading organisation members...</div>
        ) : (
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
            {members.map((member) => {
              const isSelf = member.id === currentUser?.id;
              return (
                <div key={member.id} className="p-3.5 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-900">{member.name}</span>
                      {isSelf && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200">
                          You
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">{member.email}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{ROLE_DESCRIPTIONS[member.role]}</div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isAdmin ? (
                      <select
                        aria-label={`Role for ${member.name}`}
                        value={member.role}
                        disabled={updatingUserId === member.id}
                        onChange={(e) => handleRoleChange(member.id, e.target.value as UserRole)}
                        className="px-2.5 py-1.5 text-xs font-semibold bg-slate-50 border border-slate-300 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
                      >
                        <option value="creator">Creator</option>
                        <option value="brand_manager">Brand Manager</option>
                        <option value="admin">Administrator</option>
                      </select>
                    ) : (
                      <span className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded bg-slate-100 text-slate-700 font-mono">
                        {member.role.replace('_', ' ')}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {isAdmin ? (
          <form onSubmit={handleAddMember} className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
            <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <UserPlus className="w-3.5 h-3.5 text-teal-600" />
              <span>Provision Team Member Account</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="Alex Rivera"
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Work Email</label>
                <input
                  type="email"
                  required
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  placeholder="alex@company.com"
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Initial Password (8+ chars)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newMemberPassword}
                  onChange={(e) => setNewMemberPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Assigned Role</label>
                <select
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value as UserRole)}
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="creator">Creator</option>
                  <option value="brand_manager">Brand Manager</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
            </div>
            <button
              type="submit"
              disabled={addingMember}
              className="px-4 py-2 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {addingMember ? 'Provisioning User...' : 'Add Team Member'}
            </button>
          </form>
        ) : (
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 flex items-center gap-2">
            <Lock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span>Only organisation Administrators can provision new team members or modify assigned roles.</span>
          </div>
        )}
      </div>

      {/* Immutable Audit Trail */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <History className="w-4 h-4 text-teal-600" />
              <span>Immutable Security & Governance Audit Log</span>
            </h3>
            <p className="text-xs text-slate-500">
              Tamper-evident record of authentication, policy edits, role changes, and approval decisions
            </p>
          </div>
          {canViewAuditLogs && (
            <button
              onClick={loadAuditLogs}
              disabled={auditLoading}
              className="px-3 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${auditLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          )}
        </div>

        {!canViewAuditLogs ? (
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 flex items-center gap-2">
            <Lock className="w-4 h-4 text-slate-500 shrink-0" />
            <span>Audit logs are restricted to Brand Managers and Administrators.</span>
          </div>
        ) : auditError ? (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">{auditError}</div>
        ) : auditLogs.length === 0 ? (
          <div className="text-xs text-slate-500 py-4">No audit events recorded for this workspace yet.</div>
        ) : (
          <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {auditLogs.map((log) => (
              <div key={log.id} className="p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-800">
                      {log.action}
                    </span>
                    <span className="font-semibold text-slate-800">{log.actor_name || log.actor_email || 'System'}</span>
                    {log.actor_role && (
                      <span className="text-[10px] uppercase font-mono text-slate-500">
                        ({log.actor_role.replace('_', ' ')})
                      </span>
                    )}
                  </div>
                  <div className="text-slate-600 truncate">{log.details}</div>
                </div>
                <div className="text-[11px] font-mono text-slate-400 shrink-0">
                  {new Date(log.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Security & Responsible AI Framework */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
          <Shield className="w-4 h-4 text-teal-600" />
          <span>Security & Responsible AI Architecture</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="font-bold text-slate-900 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-slate-700" />
              <span>Human-in-the-Loop & Anti-Self-Approval</span>
            </div>
            <p className="text-slate-600 leading-relaxed">
              BrandGuard AI never autonomously publishes material. Backend routes enforce separation of duties so
              creators cannot approve their own submissions.
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="font-bold text-slate-900 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-slate-700" />
              <span>Dual Engine Resilience</span>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Server-side Gemini analysis is paired with a deterministic rule-based engine so compliance auditing runs
              reliably even when external AI connectivity is unavailable.
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="font-bold text-slate-900 flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-slate-700" />
              <span>Cryptographic Sessions & Org Isolation</span>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Accounts use salted scrypt password hashes and HttpOnly HMAC-hashed database sessions, with every record
              scoped to a verified organisation ID.
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="font-bold text-slate-900 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-slate-700" />
              <span>Immutable Version & Audit Trails</span>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Every content edit, issue resolution, comment, and approval decision generates a permanent versioned and
              audited record in version-migrated persistent storage.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
