import crypto from 'crypto';
import { DbAdapter } from '../db/types.js';
import { ObjectStorageService } from './objectStorage.js';
import { DocumentValidationError, ExtractedPage, extractTextFromFile } from '../documentParser.js';
import { computeLocalLexicalEmbedding, cosineSimilarity, embedText, embedTexts } from './embeddingService.js';
import { StorageUnavailableError } from '../errors.js';

export class DuplicateDocumentError extends Error {
  statusCode = 409;
  existingDocumentId: string;
  filename: string;
  constructor(existingDocumentId: string, filename: string) {
    super(`Duplicate document detected: "${filename}" is already indexed for this organisation (ID: ${existingDocumentId}).`);
    this.name = 'DuplicateDocumentError';
    this.existingDocumentId = existingDocumentId;
    this.filename = filename;
  }
}

export interface TextChunk {
  sourceName: string;
  pageNumber: number;
  sectionTitle: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
}

export interface IngestedDocumentSummary {
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
  extracted_text_preview: string;
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

export interface RetrievalReport {
  items: RetrievedEvidenceItem[];
  searched_chunks: number;
  searched_guidelines: number;
  searched_facts: number;
  searched_terminology: number;
  max_score: number;
  missing_evidence_warning: boolean;
  warning_message?: string;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'with', 'that', 'this', 'from', 'have', 'was', 'were',
  'will', 'your', 'our', 'can', 'not', 'but', 'all', 'use', 'into', 'than', 'then',
  'about', 'their', 'has', 'had', 'its', 'you', 'they', 'when', 'where', 'what',
]);

export function tokenizeForBm25(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%$#-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export function chunkExtractedPages(
  sourceName: string,
  pages: ExtractedPage[],
  options: { chunkSize?: number; overlap?: number } = {}
): TextChunk[] {
  const chunkSize = options.chunkSize ?? 750;
  const overlap = Math.min(options.overlap ?? 150, Math.floor(chunkSize / 2));
  const chunks: TextChunk[] = [];
  let globalIndex = 0;

  for (const page of pages) {
    const clean = page.text.replace(/\r\n/g, '\n').trim();
    if (!clean) continue;

    const sectionTitle = page.sectionTitle || `Page ${page.pageNumber}`;
    if (clean.length <= chunkSize) {
      chunks.push({
        sourceName,
        pageNumber: page.pageNumber,
        sectionTitle,
        chunkIndex: globalIndex++,
        content: clean,
        tokenCount: clean.split(/\s+/).filter(Boolean).length,
      });
      continue;
    }

    let start = 0;
    while (start < clean.length) {
      let end = Math.min(clean.length, start + chunkSize);
      if (end < clean.length) {
        const breakPos = Math.max(
          clean.lastIndexOf('\n', end),
          clean.lastIndexOf('. ', end),
          clean.lastIndexOf(' ', end)
        );
        if (breakPos > start + Math.floor(chunkSize * 0.5)) {
          end = breakPos + 1;
        }
      }

      const slice = clean.slice(start, end).trim();
      if (slice.length >= 20) {
        chunks.push({
          sourceName,
          pageNumber: page.pageNumber,
          sectionTitle,
          chunkIndex: globalIndex++,
          content: slice,
          tokenCount: slice.split(/\s+/).filter(Boolean).length,
        });
      }

      if (end >= clean.length) break;
      start = Math.max(start + 1, end - overlap);
    }
  }

  return chunks;
}

export async function ingestOrgDocument(params: {
  db: DbAdapter;
  storage: ObjectStorageService;
  orgId: string;
  userId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType?: string;
}): Promise<IngestedDocumentSummary> {
  const { db, storage, orgId, userId, fileBuffer, fileName, mimeType } = params;
  const cleanFileName = String(fileName || '').trim();
  if (!cleanFileName) {
    throw new DocumentValidationError('Filename is required.');
  }

  // 1. Validate & extract pages/text (including scanned PDF detection)
  const extracted = await extractTextFromFile(fileBuffer, cleanFileName, mimeType);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // 2. Organisation-scoped duplicate detection via SHA-256
  const existingDoc = await db.queryOne<{ id: string; filename: string }>(
    'SELECT id, filename FROM rag_documents WHERE org_id = $1 AND sha256 = $2',
    [orgId, sha256]
  );
  if (existingDoc) {
    throw new DuplicateDocumentError(existingDoc.id, existingDoc.filename);
  }

  // 3. Persist original document in private org-scoped object storage (or sqlite_dev in local dev)
  const fileId = `FILE-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
  const docId = `DOC-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
  const now = new Date().toISOString();
  const safeMime =
    mimeType ||
    (extracted.format === 'pdf'
      ? 'application/pdf'
      : extracted.format === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/plain');

  let uploadedLocation: { bucket: string; objectKey: string } | null = null;
  if (storage.isConfigured()) {
    uploadedLocation = await storage.uploadObject({
      orgId,
      fileId,
      fileName: cleanFileName,
      mimeType: safeMime,
      buffer: fileBuffer,
    });
  } else if (db.dialect !== 'sqlite' || process.env.NODE_ENV === 'production') {
    throw new StorageUnavailableError(
      'Persistent S3-compatible object storage is required to store uploaded documents.'
    );
  }

  // 4. Chunk text & generate embeddings
  const chunks = extracted.ocrRequired ? [] : chunkExtractedPages(cleanFileName, extracted.pages);
  const embedded = chunks.length > 0 ? await embedTexts(chunks.map((c) => c.content)) : [];

  const indexingStatus: 'indexed' | 'partial_ocr_needed' | 'failed' = extracted.ocrRequired
    ? 'partial_ocr_needed'
    : chunks.length > 0
    ? 'indexed'
    : 'failed';

  // 5. Persist file metadata, rag_document, and document_chunks atomically
  try {
    await db.transaction(async (tx) => {
      if (uploadedLocation) {
        await tx.query(
          `INSERT INTO stored_files (id, org_id, storage_provider, bucket, object_key, filename, mime_type, size_bytes, sha256, data_base64, uploaded_by, created_at)
           VALUES ($1, $2, 's3', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            fileId,
            orgId,
            uploadedLocation.bucket,
            uploadedLocation.objectKey,
            cleanFileName,
            safeMime,
            fileBuffer.length,
            sha256,
            db.dialect === 'postgres' ? null : '',
            userId,
            now,
          ]
        );
      } else {
        await tx.query(
          `INSERT INTO stored_files (id, org_id, storage_provider, bucket, object_key, filename, mime_type, size_bytes, sha256, data_base64, uploaded_by, created_at)
           VALUES ($1, $2, 'sqlite_dev', NULL, NULL, $3, $4, $5, $6, $7, $8, $9)`,
          [
            fileId,
            orgId,
            cleanFileName,
            safeMime,
            fileBuffer.length,
            sha256,
            fileBuffer.toString('base64'),
            userId,
            now,
          ]
        );
      }

      await tx.query(
        `INSERT INTO rag_documents (id, org_id, stored_file_id, filename, mime_type, size_bytes, sha256, page_count, chunk_count, ocr_used, indexing_status, warnings, uploaded_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          docId,
          orgId,
          fileId,
          cleanFileName,
          safeMime,
          fileBuffer.length,
          sha256,
          extracted.pageCount,
          chunks.length,
          extracted.ocrUsed ? 1 : 0,
          indexingStatus,
          JSON.stringify(extracted.warnings),
          userId,
          now,
        ]
      );

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const emb = embedded[i];
        await tx.query(
          `INSERT INTO document_chunks (id, org_id, document_id, source_name, page_number, section_title, chunk_index, content, token_count, embedding_json, embedding_model, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            `CHK-${docId.slice(4)}-${i + 1}`,
            orgId,
            docId,
            chunk.sourceName,
            chunk.pageNumber,
            chunk.sectionTitle,
            chunk.chunkIndex,
            chunk.content,
            chunk.tokenCount,
            JSON.stringify(emb.vector),
            emb.model,
            now,
          ]
        );
      }
    });
  } catch (err) {
    if (uploadedLocation) {
      await storage.deleteObject(uploadedLocation.objectKey).catch(() => undefined);
    }
    throw err;
  }

  return {
    id: docId,
    org_id: orgId,
    stored_file_id: fileId,
    filename: cleanFileName,
    mime_type: safeMime,
    size_bytes: fileBuffer.length,
    sha256,
    page_count: extracted.pageCount,
    chunk_count: chunks.length,
    ocr_used: extracted.ocrUsed,
    indexing_status: indexingStatus,
    warnings: extracted.warnings,
    created_at: now,
    extracted_text_preview: extracted.text.slice(0, 600),
  };
}

function computeBm25Score(queryTokens: string[], docTokens: string[], avgDocLen: number, idfMap: Map<string, number>): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const tfMap = new Map<string, number>();
  for (const t of docTokens) {
    tfMap.set(t, (tfMap.get(t) || 0) + 1);
  }
  const k1 = 1.5;
  const b = 0.75;
  let score = 0;
  const uniqueQuery = new Set(queryTokens);

  for (const qt of uniqueQuery) {
    const tf = tfMap.get(qt) || 0;
    if (tf === 0) continue;
    const idf = idfMap.get(qt) || 1.0;
    const denom = tf + k1 * (1 - b + b * (docTokens.length / Math.max(1, avgDocLen)));
    score += idf * ((tf * (k1 + 1)) / denom);
  }

  // Normalize smoothly to [0, 1]
  return 1 - Math.exp(-score / 3.2);
}

export async function retrieveOrgEvidence(
  db: DbAdapter,
  orgId: string,
  queryText: string,
  topK = 8
): Promise<RetrievalReport> {
  const [chunksRes, guidelinesRes, factsRes, termRes] = await Promise.all([
    db.query<{
      id: string;
      source_name: string;
      page_number: number;
      section_title: string | null;
      content: string;
      embedding_json: string;
      embedding_model: string;
    }>('SELECT id, source_name, page_number, section_title, content, embedding_json, embedding_model FROM document_chunks WHERE org_id = $1', [
      orgId,
    ]),
    db.query<{
      id: string;
      title: string;
      category: string;
      description: string;
      severity: string;
      source_document: string | null;
      prohibited_phrase: string | null;
      preferred_replacement: string | null;
    }>('SELECT * FROM guidelines WHERE org_id = $1', [orgId]),
    db.query<{ id: string; fact: string; source: string }>('SELECT id, fact, source FROM approved_facts WHERE org_id = $1', [
      orgId,
    ]),
    db.query<{ id: string; prohibited_term: string; preferred_term: string; explanation: string }>(
      'SELECT * FROM terminology WHERE org_id = $1',
      [orgId]
    ),
  ]);

  interface CorpusEntry {
    id: string;
    source_type: RetrievedEvidenceItem['source_type'];
    source_document: string;
    page_or_section: string;
    excerpt: string;
    searchableText: string;
    tokens: string[];
    embedding?: number[];
    embeddingModel?: string;
    guideline_id?: string;
  }

  const corpus: CorpusEntry[] = [];

  for (const ch of chunksRes.rows) {
    let parsedEmb: number[] | undefined;
    try {
      parsedEmb = JSON.parse(ch.embedding_json);
    } catch {
      parsedEmb = undefined;
    }
    corpus.push({
      id: ch.id,
      source_type: 'document_chunk',
      source_document: ch.source_name,
      page_or_section: ch.section_title
        ? `Page ${ch.page_number} · ${ch.section_title}`
        : `Page ${ch.page_number}`,
      excerpt: ch.content,
      searchableText: `${ch.source_name} ${ch.section_title || ''} ${ch.content}`,
      tokens: tokenizeForBm25(`${ch.section_title || ''} ${ch.content}`),
      embedding: parsedEmb,
      embeddingModel: ch.embedding_model,
    });
  }

  for (const g of guidelinesRes.rows) {
    const excerpt = `${g.title}: ${g.description}${
      g.prohibited_phrase ? ` Prohibited phrase: "${g.prohibited_phrase}".` : ''
    }${g.preferred_replacement ? ` Preferred phrasing: "${g.preferred_replacement}".` : ''}`;
    corpus.push({
      id: g.id,
      source_type: 'guideline',
      source_document: g.source_document || 'Brand Guidelines Registry',
      page_or_section: `Rule ${g.id} · ${g.category}`,
      excerpt,
      searchableText: excerpt,
      tokens: tokenizeForBm25(excerpt),
      embedding: computeLocalLexicalEmbedding(excerpt),
      embeddingModel: 'local-lexical-256',
      guideline_id: g.id,
    });
  }

  for (const f of factsRes.rows) {
    const excerpt = `${f.fact} (Verified Source: ${f.source})`;
    corpus.push({
      id: f.id,
      source_type: 'approved_fact',
      source_document: f.source || 'Approved Fact Sheet',
      page_or_section: `Fact ${f.id}`,
      excerpt: f.fact,
      searchableText: excerpt,
      tokens: tokenizeForBm25(excerpt),
      embedding: computeLocalLexicalEmbedding(excerpt),
      embeddingModel: 'local-lexical-256',
      guideline_id: f.id,
    });
  }

  for (const t of termRes.rows) {
    const excerpt = `Avoid "${t.prohibited_term}"; use "${t.preferred_term}". ${t.explanation || ''}`.trim();
    corpus.push({
      id: t.id,
      source_type: 'terminology',
      source_document: 'Corporate Terminology Glossary',
      page_or_section: `Glossary ${t.id}`,
      excerpt,
      searchableText: excerpt,
      tokens: tokenizeForBm25(excerpt),
      embedding: computeLocalLexicalEmbedding(excerpt),
      embeddingModel: 'local-lexical-256',
      guideline_id: t.id,
    });
  }

  const queryTokens = tokenizeForBm25(queryText);
  const queryLocalVec = computeLocalLexicalEmbedding(queryText);
  const hasGeminiChunks = chunksRes.rows.some((c) => c.embedding_model === 'gemini-embedding-2');
  const queryGeminiVec = hasGeminiChunks ? await embedText(queryText) : null;

  // Calculate IDF across corpus
  const N = Math.max(1, corpus.length);
  const dfMap = new Map<string, number>();
  let totalLen = 0;
  for (const item of corpus) {
    totalLen += item.tokens.length;
    for (const tok of new Set(item.tokens)) {
      dfMap.set(tok, (dfMap.get(tok) || 0) + 1);
    }
  }
  const avgDocLen = totalLen / N;
  const idfMap = new Map<string, number>();
  for (const [tok, df] of dfMap.entries()) {
    idfMap.set(tok, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  const lowerQuery = queryText.toLowerCase();
  const scored: RetrievedEvidenceItem[] = corpus.map((entry) => {
    const kwScore = computeBm25Score(queryTokens, entry.tokens, avgDocLen, idfMap);
    let vecScore = 0;

    if (entry.embedding && entry.embeddingModel === 'gemini-embedding-2' && queryGeminiVec && queryGeminiVec.model === 'gemini-embedding-2') {
      vecScore = cosineSimilarity(queryGeminiVec.vector, entry.embedding);
    } else if (entry.embedding && entry.embeddingModel === 'local-lexical-256') {
      vecScore = cosineSimilarity(queryLocalVec, entry.embedding);
    } else if (entry.searchableText) {
      vecScore = cosineSimilarity(queryLocalVec, computeLocalLexicalEmbedding(entry.searchableText));
    }

    // Small exact phrase boost when guideline prohibited phrase or key term appears verbatim
    let exactBoost = 0;
    const gRow = entry.guideline_id ? guidelinesRes.rows.find((g) => g.id === entry.guideline_id) : undefined;
    if (gRow?.prohibited_phrase && lowerQuery.includes(gRow.prohibited_phrase.toLowerCase())) {
      exactBoost = 0.25;
    }
    const tRow = entry.guideline_id ? termRes.rows.find((t) => t.id === entry.guideline_id) : undefined;
    if (tRow?.prohibited_term && lowerQuery.includes(tRow.prohibited_term.toLowerCase())) {
      exactBoost = 0.25;
    }

    const hybrid = Math.min(1, Number((vecScore * 0.52 + kwScore * 0.48 + exactBoost).toFixed(4)));

    return {
      id: entry.id,
      source_type: entry.source_type,
      source_document: entry.source_document,
      page_or_section: entry.page_or_section,
      excerpt: entry.excerpt.slice(0, 600),
      score: hybrid,
      vector_score: Number(vecScore.toFixed(4)),
      keyword_score: Number(kwScore.toFixed(4)),
      guideline_id: entry.guideline_id,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const topItems = scored.slice(0, topK).filter((item) => item.score > 0.04);
  const maxScore = topItems[0]?.score ?? 0;

  const missingEvidenceWarning = corpus.length === 0 || topItems.length === 0 || maxScore < 0.14;
  let warningMessage: string | undefined;
  if (corpus.length === 0) {
    warningMessage =
      'No indexed brand policy documents, guidelines, or approved facts exist for this organisation yet. Claims cannot be verified until governance sources are added.';
  } else if (missingEvidenceWarning) {
    warningMessage =
      'Low evidence relevance in indexed policy documents and fact sheets. Claims below could not be strongly matched to organisation-approved sources and require manual verification.';
  }

  return {
    items: topItems,
    searched_chunks: chunksRes.rows.length,
    searched_guidelines: guidelinesRes.rows.length,
    searched_facts: factsRes.rows.length,
    searched_terminology: termRes.rows.length,
    max_score: Number(maxScore.toFixed(4)),
    missing_evidence_warning: missingEvidenceWarning,
    warning_message: warningMessage,
  };
}
