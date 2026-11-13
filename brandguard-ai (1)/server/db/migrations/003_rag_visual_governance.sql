-- 003_rag_visual_governance.sql
-- Round 3: Persistent RAG policy document indexing, explainable evidence citations,
-- and Visual Brand Governance & WCAG Accessibility analysis storage.

CREATE TABLE IF NOT EXISTS rag_documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  stored_file_id TEXT REFERENCES stored_files(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 1,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  ocr_used INTEGER NOT NULL DEFAULT 0,
  indexing_status TEXT NOT NULL DEFAULT 'indexed' CHECK (indexing_status IN ('indexed', 'partial_ocr_needed', 'failed')),
  warnings TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, sha256)
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  page_number INTEGER NOT NULL DEFAULT 1,
  section_title TEXT,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  embedding_json TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE compliance_issues ADD COLUMN IF NOT EXISTS source_document TEXT;
ALTER TABLE compliance_issues ADD COLUMN IF NOT EXISTS supporting_guideline_excerpt TEXT;
ALTER TABLE compliance_issues ADD COLUMN IF NOT EXISTS page_or_section TEXT;
ALTER TABLE compliance_issues ADD COLUMN IF NOT EXISTS evidence_status TEXT NOT NULL DEFAULT 'Unverified';
ALTER TABLE compliance_issues ADD COLUMN IF NOT EXISTS confidence_score INTEGER NOT NULL DEFAULT 75;

CREATE TABLE IF NOT EXISTS visual_analyses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  asset_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  stored_file_id TEXT REFERENCES stored_files(id) ON DELETE SET NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  extracted_colors_json TEXT NOT NULL DEFAULT '[]',
  detected_fonts_json TEXT NOT NULL DEFAULT '[]',
  logo_similarity_score INTEGER,
  matched_logo_asset_id TEXT,
  wcag_results_json TEXT NOT NULL DEFAULT '[]',
  findings_json TEXT NOT NULL DEFAULT '[]',
  limitations_json TEXT NOT NULL DEFAULT '[]',
  overall_score INTEGER NOT NULL DEFAULT 100,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_org ON rag_documents (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_chunks_org_doc ON document_chunks (org_id, document_id, chunk_index ASC);
CREATE INDEX IF NOT EXISTS idx_visual_analyses_org_sub ON visual_analyses (org_id, submission_id, created_at DESC);
