import { Type } from '@google/genai';
import { createGeminiClient } from './services/embeddingService.js';
import type { RetrievedEvidenceItem } from './services/ragService.js';

export type EvidenceStatus = 'Supported' | 'Contradicted' | 'Unverified';

export interface AnalyzedIssue {
  title: string;
  category: 'Tone' | 'Terminology' | 'Messaging' | 'Facts' | 'Claims' | 'Visual identity' | 'Accessibility';
  severity: 'High' | 'Medium' | 'Low';
  problematic_text: string;
  explanation: string;
  source_guideline_id?: string;
  source_document?: string;
  supporting_guideline_excerpt?: string;
  page_or_section?: string;
  evidence_status: EvidenceStatus;
  confidence_score: number;
  suggested_correction: string;
  confidence: 'High' | 'Medium' | 'Unverified';
}

export interface AnalysisResult {
  compliance_score: number;
  overall_summary: string;
  issues: AnalyzedIssue[];
  used_ai: boolean;
}

export async function analyzeWithGemini(
  content: string,
  contentType: string,
  guidelines: Array<{
    id: string;
    title: string;
    category: string;
    description: string;
    severity: string;
    source_document?: string;
    prohibited_phrase?: string;
    preferred_replacement?: string;
  }>,
  approvedFacts: Array<{ id: string; fact: string; source: string }>,
  terminology: Array<{ id: string; prohibited_term: string; preferred_term: string; explanation: string }>,
  retrievedEvidence: RetrievedEvidenceItem[] = []
): Promise<AnalysisResult | null> {
  const ai = createGeminiClient();
  if (!ai) {
    return null;
  }

  const prompt = `
You are the Evidence-Grounded Brand Compliance Officer for "BrandGuard AI".
Analyze the submitted content strictly using the retrieved policy document passages, approved guidelines, verified facts, and corporate glossary below.

SUBMITTED CONTENT (${contentType}):
"""
${content}
"""

RETRIEVED EVIDENCE PASSAGES (HYBRID VECTOR + BM25 SEARCH):
${JSON.stringify(retrievedEvidence, null, 2)}

APPROVED BRAND GUIDELINES REGISTRY:
${JSON.stringify(guidelines, null, 2)}

APPROVED VERIFIED CORPORATE FACTS:
${JSON.stringify(approvedFacts, null, 2)}

APPROVED TERMINOLOGY & GLOSSARY:
${JSON.stringify(terminology, null, 2)}

STRICT EVIDENCE GROUNDING RULES:
1. NEVER invent policy documents, excerpts, page numbers, citations, or facts not present in the context above.
2. Every issue MUST cite the exact retrieved "source_document" and "page_or_section" and copy an exact verbatim quote into "supporting_guideline_excerpt" when a matching passage/rule/fact exists.
3. Set "evidence_status" strictly as:
   - "Contradicted": when the submitted text violates a retrieved policy rule/prohibited phrase or directly contradicts an approved corporate fact (e.g., wrong founding year, wrong SLA, forbidden guarantee).
   - "Unverified": when a factual/quantitative claim (metric, user count, year, certification) has NO supporting or contradicting record in retrieved documents or approved facts. For "Unverified", set "source_document" to "No Indexed Source Found" and "supporting_guideline_excerpt" to "No supporting evidence found in indexed organisation documents or approved facts.", and "confidence" to "Unverified".
   - "Supported": when an editorial recommendation is directly supported by a positive policy standard excerpt.
4. Provide numeric "confidence_score" (0-100) reflecting evidence alignment strength (e.g., 85-98 for exact rule/fact match, 30-55 for unverified claims without retrieved evidence).
5. Provide exact verbatim substring from the submitted content in "problematic_text".
6. Calculate an overall "compliance_score" between 0 and 100.
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'You are an enterprise brand compliance auditing engine. Never fabricate citations or guideline quotes. Return structured JSON.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            compliance_score: {
              type: Type.INTEGER,
              description: 'Score from 0 to 100 based on severity and count of findings',
            },
            overall_summary: {
              type: Type.STRING,
              description: 'Executive summary grounded in retrieved brand policies and verified facts',
            },
            issues: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  category: {
                    type: Type.STRING,
                    description: 'Tone, Terminology, Messaging, Facts, Claims, Visual identity, or Accessibility',
                  },
                  severity: {
                    type: Type.STRING,
                    description: 'High, Medium, or Low',
                  },
                  problematic_text: {
                    type: Type.STRING,
                    description: 'Exact substring from submitted content',
                  },
                  explanation: {
                    type: Type.STRING,
                    description: 'Why this is a governance issue grounded in cited policy',
                  },
                  source_guideline_id: {
                    type: Type.STRING,
                    description: 'Matched guideline, fact, or chunk ID if applicable',
                  },
                  source_document: {
                    type: Type.STRING,
                    description: 'Exact retrieved document name or "No Indexed Source Found"',
                  },
                  supporting_guideline_excerpt: {
                    type: Type.STRING,
                    description: 'Verbatim excerpt from retrieved policy or approved fact',
                  },
                  page_or_section: {
                    type: Type.STRING,
                    description: 'Retrieved page number or section label',
                  },
                  evidence_status: {
                    type: Type.STRING,
                    description: 'Supported, Contradicted, or Unverified',
                  },
                  confidence_score: {
                    type: Type.INTEGER,
                    description: 'Numeric confidence 0-100',
                  },
                  suggested_correction: {
                    type: Type.STRING,
                    description: 'Brand-safe replacement text',
                  },
                  confidence: {
                    type: Type.STRING,
                    description: 'High, Medium, or Unverified',
                  },
                },
                required: [
                  'title',
                  'category',
                  'severity',
                  'problematic_text',
                  'explanation',
                  'source_document',
                  'supporting_guideline_excerpt',
                  'page_or_section',
                  'evidence_status',
                  'confidence_score',
                  'suggested_correction',
                  'confidence',
                ],
              },
            },
          },
          required: ['compliance_score', 'overall_summary', 'issues'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    if (parsed && Array.isArray(parsed.issues)) {
      const normalizedIssues: AnalyzedIssue[] = parsed.issues.map((item: any) => {
        const numericScore = Math.max(
          0,
          Math.min(100, Number(item.confidence_score ?? (item.confidence === 'Unverified' ? 40 : 85)))
        );
        const evStatus: EvidenceStatus =
          item.evidence_status === 'Supported' || item.evidence_status === 'Contradicted' || item.evidence_status === 'Unverified'
            ? item.evidence_status
            : item.confidence === 'Unverified'
            ? 'Unverified'
            : 'Contradicted';

        return {
          title: String(item.title || 'Compliance Finding'),
          category: item.category || 'Messaging',
          severity: item.severity === 'High' || item.severity === 'Low' ? item.severity : 'Medium',
          problematic_text: String(item.problematic_text || ''),
          explanation: String(item.explanation || ''),
          source_guideline_id: item.source_guideline_id || undefined,
          source_document: String(item.source_document || 'Brand Governance Policy'),
          supporting_guideline_excerpt: String(
            item.supporting_guideline_excerpt || 'No supporting excerpt supplied.'
          ),
          page_or_section: String(item.page_or_section || 'Retrieved Evidence'),
          evidence_status: evStatus,
          confidence_score: Math.round(numericScore),
          suggested_correction: String(item.suggested_correction || ''),
          confidence:
            evStatus === 'Unverified'
              ? 'Unverified'
              : numericScore >= 75
              ? 'High'
              : 'Medium',
        };
      });

      return {
        compliance_score: Math.max(0, Math.min(100, parsed.compliance_score ?? 70)),
        overall_summary: parsed.overall_summary || 'Evidence-grounded compliance check completed.',
        issues: normalizedIssues,
        used_ai: true,
      };
    }
    return null;
  } catch (error) {
    console.error('Gemini API analysis failed, falling back to deterministic RAG rule engine:', error);
    return null;
  }
}
