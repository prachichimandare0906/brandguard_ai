export type UserRole = 'creator' | 'brand_manager' | 'admin';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string | null;
}

export interface OrgMembership {
  orgId: string;
  name: string;
  slug: string;
  role: UserRole;
  created_at?: string;
}

export interface OrgMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string | null;
  joined_at: string;
}

export type GuidelineCategory =
  | 'Tone'
  | 'Terminology'
  | 'Messaging'
  | 'Facts'
  | 'Claims'
  | 'Visual identity'
  | 'Accessibility';

export type SeverityLevel = 'High' | 'Medium' | 'Low';

export interface Guideline {
  id: string;
  org_id?: string;
  title: string;
  category: GuidelineCategory;
  description: string;
  severity: SeverityLevel;
  source_document?: string;
  prohibited_phrase?: string | null;
  preferred_replacement?: string | null;
  created_at: string;
}

export interface ApprovedFact {
  id: string;
  org_id?: string;
  fact: string;
  source: string;
  verified_at: string;
  created_at: string;
}

export interface TerminologyItem {
  id: string;
  org_id?: string;
  prohibited_term: string;
  preferred_term: string;
  explanation: string;
  created_at: string;
}

export interface BrandAsset {
  id: string;
  org_id?: string;
  asset_name: string;
  asset_type: string;
  file_path: string;
  guidelines?: string;
  created_at: string;
}

export type SubmissionStatus = 'Draft' | 'In Review' | 'Needs Revision' | 'Approved' | 'Rejected';

export type ContentType =
  | 'Social Media'
  | 'Email Campaign'
  | 'Advertisement'
  | 'Website Copy'
  | 'Press Release';

export type EvidenceStatus = 'Supported' | 'Contradicted' | 'Unverified';

export interface ComplianceIssue {
  id: string;
  org_id?: string;
  submission_id: string;
  title: string;
  category: GuidelineCategory;
  severity: SeverityLevel;
  problematic_text: string;
  explanation: string;
  source_guideline_id?: string;
  source_document?: string;
  supporting_guideline_excerpt?: string;
  page_or_section?: string;
  evidence_status?: EvidenceStatus;
  confidence_score?: number;
  suggested_correction: string;
  confidence: 'High' | 'Medium' | 'Unverified';
  human_status: 'Pending' | 'Accepted' | 'Rejected' | 'Modified';
  created_at: string;
}

export interface RagDocument {
  id: string;
  org_id: string;
  stored_file_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  page_count: number;
  chunk_count: number;
  ocr_used: boolean;
  indexing_status: 'indexed' | 'partial_ocr_needed' | 'failed';
  warnings: string[];
  created_at: string;
  extracted_text_preview?: string;
}

export interface RetrievedEvidenceItem {
  id: string;
  source_type: 'document_chunk' | 'guideline' | 'approved_fact' | 'terminology';
  source_document: string;
  page_or_section: string;
  excerpt: string;
  score: number;
  vector_score: number;
  keyword_score: number;
  guideline_id?: string;
}

export interface RetrievalSummary {
  searched_chunks: number;
  searched_guidelines: number;
  searched_facts: number;
  searched_terminology?: number;
  max_score: number;
  missing_evidence_warning: boolean;
  warning_message?: string;
}

export interface OrgBrandSettings {
  primaryColors: string[];
  approvedFonts: string[];
}

export interface ExtractedColor {
  hex: string;
  percentage: number;
  nearestApprovedHex: string;
  deltaE: number;
  isOnBrand: boolean;
}

export interface WcagPairResult {
  label: string;
  foregroundHex: string;
  backgroundHex: string;
  contrastRatio: number;
  aaNormalPass: boolean;
  aaLargePass: boolean;
  aaaNormalPass: boolean;
  suggestedForegroundHex?: string;
  suggestedContrastRatio?: number;
  source: string;
}

export interface VisualFinding {
  id: string;
  category: 'Logo Usage' | 'Brand Color' | 'Typography' | 'Accessibility' | 'WCAG Contrast';
  severity: 'High' | 'Medium' | 'Low';
  title: string;
  explanation: string;
  suggested_fix: string;
  evidence: string;
}

export interface VisualAnalysisResult {
  id: string;
  org_id: string;
  submission_id: string | null;
  asset_name: string;
  mime_type: string;
  stored_file_id: string | null;
  image_url: string | null;
  dimensions?: { width: number; height: number } | null;
  alt_text: string;
  extracted_colors: ExtractedColor[];
  detected_fonts: Array<{ family: string; approved: boolean }>;
  logo_similarity_score: number | null;
  matched_logo_asset_id: string | null;
  matched_logo_name: string | null;
  matched_logo_path: string | null;
  wcag_results: WcagPairResult[];
  findings: VisualFinding[];
  limitations: string[];
  overall_score: number;
  created_at: string;
}

export interface ReviewLog {
  id: string;
  org_id?: string;
  submission_id: string;
  reviewer_id: string;
  reviewer_name?: string;
  reviewer_role?: string;
  reviewer_avatar?: string;
  decision: 'Approved' | 'Rejected' | 'Needs Revision';
  comments?: string;
  created_at: string;
}

export interface ContentVersion {
  id: string;
  org_id?: string;
  submission_id: string;
  version_number: number;
  content: string;
  created_by?: string;
  author_name?: string;
  change_summary?: string;
  compliance_score?: number;
  created_at: string;
}

export interface SubmissionComment {
  id: string;
  org_id: string;
  submission_id: string;
  issue_id?: string | null;
  author_id: string;
  author_name: string;
  author_role: UserRole;
  author_avatar?: string | null;
  body: string;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  org_id: string;
  actor_id?: string | null;
  actor_name?: string | null;
  actor_email?: string | null;
  actor_role?: string | null;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  details: string;
  created_at: string;
}

export interface Submission {
  id: string;
  org_id?: string;
  title: string;
  content: string;
  original_content: string;
  content_type: ContentType;
  created_by: string;
  author_name?: string;
  author_role?: string;
  status: SubmissionStatus;
  compliance_score: number;
  created_at: string;
  updated_at: string;
  total_issues?: number;
  high_issues?: number;
}

export interface AnalyticsData {
  metrics: {
    totalSubmissions: number;
    approvedSubmissions: number;
    rejectedSubmissions: number;
    pendingReviews: number;
    needsRevision: number;
    totalIssues: number;
  };
  submissionsByStatus: Array<{ name: string; count: number; color: string }>;
  issuesByCategory: Array<{ category: string; count: number }>;
  issuesBySeverity: Array<{ severity: string; count: number }>;
  topViolatedRules: Array<{ id: string; title: string; category: string; violations: number }>;
  repeatedTerminology: Array<{ term: string; count: number; preferred: string }>;
  unclearGuidelines: Array<{ id: string; title: string; category: string; violations: number }>;
  monthlyTrends?: Array<{ month: string; submissions: number; avgScore: number }>;
}
