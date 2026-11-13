import {
  User,
  UserRole,
  OrgMembership,
  OrgMember,
  Guideline,
  ApprovedFact,
  TerminologyItem,
  BrandAsset,
  Submission,
  ComplianceIssue,
  ReviewLog,
  ContentVersion,
  SubmissionComment,
  AuditLogEntry,
  AnalyticsData,
  RagDocument,
  RetrievedEvidenceItem,
  RetrievalSummary,
  OrgBrandSettings,
  VisualAnalysisResult,
  VisualFinding,
} from '../types';

const API_BASE_URL = String((import.meta as any).env?.VITE_API_BASE_URL || '').replace(/\/+$/, '');

let activeOrgHeaderId: string | null = null;
let onUnauthorizedCallback: (() => void) | null = null;

export function setActiveOrgHeader(orgId: string | null) {
  activeOrgHeaderId = orgId;
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorizedCallback = handler;
}

function getClientContextHeader(): 'iframe' | 'cross-origin' | 'same-origin' {
  if (typeof window !== 'undefined') {
    try {
      if (window.self !== window.top) return 'iframe';
    } catch {
      return 'iframe';
    }
    if (API_BASE_URL) {
      try {
        if (new URL(API_BASE_URL, window.location.origin).origin !== window.location.origin) {
          return 'cross-origin';
        }
      } catch {
        // Ignore malformed VITE_API_BASE_URL
      }
    }
  }
  return 'same-origin';
}

export class ApiError extends Error {
  status: number;
  isNetworkError: boolean;
  constructor(message: string, status: number, isNetworkError = false) {
    super(message);
    this.status = status;
    this.isNetworkError = isNetworkError;
  }
}

async function apiFetch<T>(url: string, init: RequestInit = {}, skipUnauthorizedHook = false): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (activeOrgHeaderId) {
    headers.set('X-Org-Id', activeOrgHeaderId);
  }
  headers.set('X-Client-Context', getClientContextHeader());
  if (typeof window !== 'undefined' && window.location?.protocol) {
    headers.set('X-Client-Protocol', window.location.protocol);
  }

  const targetUrl = API_BASE_URL && url.startsWith('/') ? `${API_BASE_URL}${url}` : url;

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(
      'Unable to reach BrandGuard AI server. Check your network connection and retry.',
      0,
      true
    );
  }

  if (res.status === 401 && !skipUnauthorizedHook) {
    onUnauthorizedCallback?.();
  }

  const text = await res.text();
  let parsed: any = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(parsed?.error || `Request failed with status ${res.status}`, res.status, false);
  }

  return parsed as T;
}

export interface AuthResponse {
  user: User;
  activeOrg: OrgMembership;
  memberships: OrgMembership[];
  role: UserRole;
}

export interface SessionProbeResponse {
  authenticated: boolean;
  expired?: boolean;
  user: User | null;
  activeOrg: OrgMembership | null;
  memberships: OrgMembership[];
  role: UserRole | null;
}

export const api = {
  // Authentication & Session
  async register(data: {
    name: string;
    email: string;
    password: string;
    orgName: string;
    seedStarterBrand?: boolean;
  }): Promise<AuthResponse> {
    return apiFetch<AuthResponse>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify(data) },
      true
    );
  },

  async login(data: { email: string; password: string }): Promise<AuthResponse> {
    return apiFetch<AuthResponse>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify(data) },
      true
    );
  },

  async logout(): Promise<{ success: boolean }> {
    return apiFetch<{ success: boolean }>('/api/auth/logout', { method: 'POST' }, true);
  },

  async getSession(): Promise<SessionProbeResponse> {
    return apiFetch<SessionProbeResponse>('/api/auth/session', {}, true);
  },

  async me(): Promise<AuthResponse> {
    return apiFetch<AuthResponse>('/api/auth/me', {}, true);
  },

  async switchOrg(orgId: string): Promise<{ success: boolean; activeOrg: OrgMembership; role: UserRole }> {
    return apiFetch('/api/auth/switch-org', {
      method: 'POST',
      body: JSON.stringify({ orgId }),
    });
  },

  // Organisations & Team Members
  async getOrgs(): Promise<{ organisations: OrgMembership[] }> {
    return apiFetch('/api/orgs');
  },

  async createOrg(data: { name: string; seedStarterBrand?: boolean }): Promise<{ activeOrg: OrgMembership }> {
    return apiFetch('/api/orgs', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async getOrgMembers(orgId: string): Promise<{ members: OrgMember[] }> {
    return apiFetch(`/api/orgs/${orgId}/members`);
  },

  async addOrgMember(
    orgId: string,
    data: { name: string; email: string; password: string; role: UserRole }
  ): Promise<{ member: OrgMember }> {
    return apiFetch(`/api/orgs/${orgId}/members`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateOrgMemberRole(
    orgId: string,
    userId: string,
    role: UserRole
  ): Promise<{ success: boolean; userId: string; role: UserRole }> {
    return apiFetch(`/api/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
  },

  // Guidelines
  async getGuidelines(): Promise<Guideline[]> {
    return apiFetch('/api/guidelines');
  },

  async createGuideline(data: Partial<Guideline>): Promise<Guideline> {
    return apiFetch('/api/guidelines', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateGuideline(id: string, data: Partial<Guideline>): Promise<Guideline> {
    return apiFetch(`/api/guidelines/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteGuideline(id: string): Promise<{ success: boolean }> {
    return apiFetch(`/api/guidelines/${id}`, { method: 'DELETE' });
  },

  // Approved Facts
  async getFacts(): Promise<ApprovedFact[]> {
    return apiFetch('/api/facts');
  },

  async createFact(data: { fact: string; source: string }): Promise<ApprovedFact> {
    return apiFetch('/api/facts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async deleteFact(id: string): Promise<{ success: boolean }> {
    return apiFetch(`/api/facts/${id}`, { method: 'DELETE' });
  },

  // Terminology
  async getTerminology(): Promise<TerminologyItem[]> {
    return apiFetch('/api/terminology');
  },

  async createTerminology(data: {
    prohibited_term: string;
    preferred_term: string;
    explanation?: string;
  }): Promise<TerminologyItem> {
    return apiFetch('/api/terminology', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async deleteTerminology(id: string): Promise<{ success: boolean }> {
    return apiFetch(`/api/terminology/${id}`, { method: 'DELETE' });
  },

  // Assets
  async getAssets(): Promise<BrandAsset[]> {
    return apiFetch('/api/assets');
  },

  async createAsset(
    data: Partial<BrandAsset> & { fileBase64?: string; fileName?: string; mimeType?: string }
  ): Promise<BrandAsset> {
    return apiFetch('/api/assets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async deleteAsset(id: string): Promise<{ success: boolean }> {
    return apiFetch(`/api/assets/${id}`, { method: 'DELETE' });
  },

  // Document parsing
  async parseDocument(
    fileBase64: string,
    fileName: string,
    mimeType?: string
  ): Promise<{ text: string; pageCount?: number; ocrUsed?: boolean; ocrRequired?: boolean; warnings?: string[] }> {
    return apiFetch('/api/documents/parse', {
      method: 'POST',
      body: JSON.stringify({ fileBase64, fileName, mimeType }),
    });
  },

  // RAG Policy Document Ingestion & Retrieval
  async getRagDocuments(): Promise<{ documents: RagDocument[] }> {
    return apiFetch('/api/rag/documents');
  },

  async ingestRagDocument(
    fileBase64: string,
    fileName: string,
    mimeType?: string
  ): Promise<{ document: RagDocument }> {
    return apiFetch('/api/rag/documents', {
      method: 'POST',
      body: JSON.stringify({ fileBase64, fileName, mimeType }),
    });
  },

  async deleteRagDocument(id: string): Promise<{ success: boolean; id: string }> {
    return apiFetch(`/api/rag/documents/${id}`, { method: 'DELETE' });
  },

  async searchRagEvidence(query: string, topK = 8): Promise<RetrievalSummary & { items: RetrievedEvidenceItem[] }> {
    return apiFetch('/api/rag/search', {
      method: 'POST',
      body: JSON.stringify({ query, topK }),
    });
  },

  // Org Brand Settings (Approved Palette & Fonts)
  async getOrgBrandSettings(): Promise<OrgBrandSettings> {
    return apiFetch('/api/org/brand-settings');
  },

  async updateOrgBrandSettings(data: OrgBrandSettings): Promise<OrgBrandSettings> {
    return apiFetch('/api/org/brand-settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  // Visual Brand Governance & WCAG Accessibility
  async getVisualAnalyses(submissionId?: string): Promise<{ analyses: VisualAnalysisResult[] }> {
    const query = submissionId ? `?submission_id=${encodeURIComponent(submissionId)}` : '';
    return apiFetch(`/api/visual/analyses${query}`);
  },

  async analyzeVisualAsset(data: {
    fileBase64?: string;
    fileName?: string;
    mimeType?: string;
    altText?: string;
    htmlOrCss?: string;
    foregroundHex?: string;
    backgroundHex?: string;
    submissionId?: string;
  }): Promise<{ analysis: VisualAnalysisResult }> {
    return apiFetch('/api/visual/analyze', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateVisualAltText(
    id: string,
    altText: string
  ): Promise<{ success: boolean; id: string; alt_text: string; findings: VisualFinding[]; overall_score: number }> {
    return apiFetch(`/api/visual/analyses/${id}/alt-text`, {
      method: 'PATCH',
      body: JSON.stringify({ altText }),
    });
  },

  // Submissions & Analysis
  async analyzeContent(data: {
    title: string;
    content: string;
    content_type: string;
    submission_id?: string;
  }): Promise<{
    submission: Submission;
    issues: ComplianceIssue[];
    compliance_score: number;
    overall_summary: string;
    used_ai: boolean;
    retrieved_evidence?: RetrievedEvidenceItem[];
    retrieval_summary?: RetrievalSummary;
  }> {
    return apiFetch('/api/submissions/analyze', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async getSubmissions(): Promise<Submission[]> {
    return apiFetch('/api/submissions');
  },

  async getSubmissionDetails(id: string): Promise<{
    submission: Submission;
    issues: ComplianceIssue[];
    reviews: ReviewLog[];
    versions: ContentVersion[];
    comments: SubmissionComment[];
    visual_analyses?: VisualAnalysisResult[];
  }> {
    return apiFetch(`/api/submissions/${id}`);
  },

  async updateContent(
    id: string,
    content: string,
    compliance_score?: number,
    change_summary?: string
  ): Promise<{ success: boolean; submission: Submission; version_number: number }> {
    return apiFetch(`/api/submissions/${id}/content`, {
      method: 'PATCH',
      body: JSON.stringify({ content, compliance_score, change_summary }),
    });
  },

  async updateIssueStatus(
    submissionId: string,
    issueId: string,
    human_status: string,
    suggested_correction?: string
  ): Promise<ComplianceIssue> {
    return apiFetch(`/api/submissions/${submissionId}/issue/${issueId}`, {
      method: 'PATCH',
      body: JSON.stringify({ human_status, suggested_correction }),
    });
  },

  async submitForReview(id: string): Promise<{ success: boolean; submission: Submission }> {
    return apiFetch(`/api/submissions/${id}/submit-review`, {
      method: 'POST',
    });
  },

  async reviewSubmission(
    id: string,
    decision: 'Approved' | 'Rejected' | 'Needs Revision',
    comments: string
  ): Promise<{
    success: boolean;
    submission: Submission;
    reviews: ReviewLog[];
  }> {
    return apiFetch(`/api/submissions/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, comments }),
    });
  },

  // Collaboration Comments
  async getComments(submissionId: string): Promise<{ comments: SubmissionComment[] }> {
    return apiFetch(`/api/submissions/${submissionId}/comments`);
  },

  async addComment(submissionId: string, body: string, issue_id?: string): Promise<{ comment: SubmissionComment }> {
    return apiFetch(`/api/submissions/${submissionId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, issue_id }),
    });
  },

  // Audit Logs
  async getAuditLogs(limit = 100): Promise<{ logs: AuditLogEntry[] }> {
    return apiFetch(`/api/audit-logs?limit=${limit}`);
  },

  // Analytics
  async getAnalytics(): Promise<AnalyticsData> {
    return apiFetch('/api/analytics');
  },

  // Reset Starter Workspace
  async resetDemo(): Promise<{ success: boolean; message: string }> {
    return apiFetch('/api/reset-demo', { method: 'POST' });
  },
};
