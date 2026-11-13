import { AnalyzedIssue, AnalysisResult } from './gemini.js';
import type { RetrievedEvidenceItem } from './services/ragService.js';

function findBestRetrievedChunk(
  keywords: string[],
  retrievedEvidence: RetrievedEvidenceItem[],
  preferredTypes: Array<RetrievedEvidenceItem['source_type']> = ['document_chunk', 'guideline']
): RetrievedEvidenceItem | undefined {
  const lowerTerms = keywords.map((k) => k.toLowerCase()).filter((k) => k.length >= 3);
  let best: { item: RetrievedEvidenceItem; hits: number } | null = null;

  for (const ev of retrievedEvidence) {
    if (!preferredTypes.includes(ev.source_type)) continue;
    const hay = `${ev.source_document} ${ev.excerpt}`.toLowerCase();
    let hits = 0;
    for (const kw of lowerTerms) {
      if (hay.includes(kw)) hits++;
    }
    if (hits > 0 && (!best || hits > best.hits || (hits === best.hits && ev.score > best.item.score))) {
      best = { item: ev, hits };
    }
  }
  return best?.item;
}

export function analyzeWithRuleEngine(
  content: string,
  _contentType: string,
  guidelines: Array<{
    id: string;
    title: string;
    category: string;
    description: string;
    severity: string;
    source_document?: string | null;
    prohibited_phrase?: string | null;
    preferred_replacement?: string | null;
  }>,
  approvedFacts: Array<{ id: string; fact: string; source: string }>,
  terminology: Array<{ id: string; prohibited_term: string; preferred_term: string; explanation: string }>,
  retrievedEvidence: RetrievedEvidenceItem[] = []
): AnalysisResult {
  const issues: AnalyzedIssue[] = [];

  // 1. Check prohibited terminology
  for (const term of terminology) {
    const prohibited = term.prohibited_term.toLowerCase();
    const regex = new RegExp(`\\b${escapeRegExp(prohibited)}\\b`, 'gi');
    let match;
    while ((match = regex.exec(content)) !== null) {
      const evChunk = findBestRetrievedChunk([term.prohibited_term, term.preferred_term, 'terminology'], retrievedEvidence);
      issues.push({
        title: `Prohibited Terminology: "${match[0]}"`,
        category: 'Terminology',
        severity: 'Medium',
        problematic_text: match[0],
        explanation:
          term.explanation ||
          `The term "${match[0]}" violates approved glossary terminology. Replace with "${term.preferred_term}".`,
        source_guideline_id: term.id || 'RULE-TERM-01',
        source_document: evChunk?.source_document || 'Corporate Terminology Glossary',
        supporting_guideline_excerpt:
          evChunk?.excerpt || `Avoid "${term.prohibited_term}"; use "${term.preferred_term}". ${term.explanation || ''}`.trim(),
        page_or_section: evChunk?.page_or_section || `Glossary ${term.id}`,
        evidence_status: 'Contradicted',
        confidence_score: 96,
        suggested_correction: term.preferred_term,
        confidence: 'High',
      });
    }
  }

  // 2. Check explicit guideline prohibited phrases
  for (const rule of guidelines) {
    if (rule.prohibited_phrase) {
      const phrase = rule.prohibited_phrase.toLowerCase();
      const regex = new RegExp(escapeRegExp(phrase), 'gi');
      let match;
      while ((match = regex.exec(content)) !== null) {
        const exists = issues.some(
          (i) => i.problematic_text.toLowerCase() === match![0].toLowerCase() && i.category === rule.category
        );
        if (!exists) {
          const evChunk = findBestRetrievedChunk(
            [rule.prohibited_phrase, rule.title, rule.category],
            retrievedEvidence,
            ['document_chunk']
          );
          issues.push({
            title: `Guideline Violation: ${rule.title}`,
            category: rule.category as any,
            severity: rule.severity as any,
            problematic_text: match[0],
            explanation: rule.description,
            source_guideline_id: rule.id,
            source_document: evChunk?.source_document || rule.source_document || 'Brand Guidelines Registry',
            supporting_guideline_excerpt: evChunk?.excerpt || rule.description,
            page_or_section: evChunk?.page_or_section || `Rule ${rule.id} · ${rule.category}`,
            evidence_status: 'Contradicted',
            confidence_score: 94,
            suggested_correction: rule.preferred_replacement || 'Please revise according to approved brand standards.',
            confidence: 'High',
          });
        }
      }
    }
  }

  // 3. Superlative, guarantee & urgency detection grounded in org rules/chunks
  const superlativeMatches = [
    {
      regex: /\b(best ever|#1|number one|unbeatable|world's best|100% guaranteed)\b/gi,
      title: 'Unsubstantiated Superlative Claim',
      category: 'Claims' as const,
      severity: 'High' as const,
      explanation:
        'Superlatives and unconditional superiority statements require verifiable third-party analyst benchmark citations.',
      suggested_correction: 'industry-leading',
      ruleKeywords: ['superlative', 'best ever', '#1'],
      defaultDoc: 'Brand_Voice_Policy_v2.4.pdf',
    },
    {
      regex: /\b(guarantees? results?|guaranteed outcome|guaranteed return)\b/gi,
      title: 'Unsupported Performance Guarantee',
      category: 'Claims' as const,
      severity: 'High' as const,
      explanation:
        'Performance guarantees violate legal compliance guidelines without certified trial documentation.',
      suggested_correction: 'is designed to deliver measurable outcomes',
      ruleKeywords: ['guarantees', 'performance', 'claim'],
      defaultDoc: 'Legal_Compliance_Standards.pdf',
    },
    {
      regex: /\b(buy now or miss out!?|act fast or regret|don't miss out!?|last chance!?)\b/gi,
      title: 'Aggressive Urgency & Artificial Scarcity',
      category: 'Tone' as const,
      severity: 'Medium' as const,
      explanation:
        'Violates enterprise brand voice. Tone must be informative and respectful, avoiding high-pressure urgency tactics.',
      suggested_correction: 'Explore how our platform can support your team today.',
      ruleKeywords: ['tone', 'urgency', 'scarcity', 'miss out'],
      defaultDoc: 'Brand_Voice_Policy_v2.4.pdf',
    },
  ];

  for (const sup of superlativeMatches) {
    let match;
    while ((match = sup.regex.exec(content)) !== null) {
      const alreadyReported = issues.some(
        (i) => i.problematic_text.toLowerCase() === match![0].toLowerCase()
      );
      if (!alreadyReported) {
        const matchedRule = guidelines.find(
          (g) =>
            g.category === sup.category ||
            sup.ruleKeywords.some((k) => `${g.title} ${g.description}`.toLowerCase().includes(k))
        );
        const evChunk = findBestRetrievedChunk(sup.ruleKeywords, retrievedEvidence);
        issues.push({
          title: sup.title,
          category: sup.category,
          severity: sup.severity,
          problematic_text: match[0],
          explanation: sup.explanation,
          source_guideline_id: matchedRule?.id || evChunk?.guideline_id,
          source_document: evChunk?.source_document || matchedRule?.source_document || sup.defaultDoc,
          supporting_guideline_excerpt: evChunk?.excerpt || matchedRule?.description || sup.explanation,
          page_or_section: evChunk?.page_or_section || (matchedRule ? `Rule ${matchedRule.id}` : 'Policy Standard'),
          evidence_status: 'Contradicted',
          confidence_score: evChunk || matchedRule ? 90 : 78,
          suggested_correction: sup.suggested_correction,
          confidence: 'High',
        });
      }
    }
  }

  // 4. Fact contradiction & unverified claim checks against Approved Facts + Indexed Document Chunks
  const factChunks = retrievedEvidence.filter(
    (e) => e.source_type === 'document_chunk' || e.source_type === 'approved_fact'
  );

  // 4A. Founded year contradiction check (e.g., content says "founded in 2021" vs fact "founded in 2018")
  const foundedContentMatch = content.match(/\bfounded\s+(?:in\s+)?(\d{4})\b/i);
  if (foundedContentMatch) {
    const claimedYear = foundedContentMatch[1];
    const foundedEvidence =
      approvedFacts.find((f) => /\bfounded\b.*\b\d{4}\b/i.test(f.fact)) ||
      factChunks.find((c) => /\bfounded\b.*\b\d{4}\b/i.test(c.excerpt));

    if (foundedEvidence) {
      const sourceText = 'fact' in foundedEvidence ? foundedEvidence.fact : foundedEvidence.excerpt;
      const yearMatch = sourceText.match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch && yearMatch[1] !== claimedYear) {
        issues.push({
          title: `Contradicted Founding Year ("${foundedContentMatch[0]}")`,
          category: 'Facts',
          severity: 'High',
          problematic_text: foundedContentMatch[0],
          explanation: `Submitted claim "${foundedContentMatch[0]}" directly contradicts verified corporate record stating year ${yearMatch[1]}.`,
          source_guideline_id: 'id' in foundedEvidence ? foundedEvidence.id : undefined,
          source_document:
            'source' in foundedEvidence ? foundedEvidence.source : foundedEvidence.source_document,
          supporting_guideline_excerpt: sourceText,
          page_or_section:
            'page_or_section' in foundedEvidence
              ? foundedEvidence.page_or_section
              : `Fact ${foundedEvidence.id}`,
          evidence_status: 'Contradicted',
          confidence_score: 97,
          suggested_correction: `founded in ${yearMatch[1]}`,
          confidence: 'High',
        });
      }
    } else {
      issues.push({
        title: `Unverified Founding Claim ("${foundedContentMatch[0]}")`,
        category: 'Facts',
        severity: 'Medium',
        problematic_text: foundedContentMatch[0],
        explanation: `No founding year record was found in this organisation's indexed documents or approved facts.`,
        source_document: 'No Indexed Source Found',
        supporting_guideline_excerpt:
          'No supporting evidence found in indexed organisation documents or approved facts.',
        page_or_section: 'Unverified External Claim',
        evidence_status: 'Unverified',
        confidence_score: 35,
        suggested_correction: 'remove or verify founding date against official incorporation record',
        confidence: 'Unverified',
      });
    }
  }

  // 4B. Uptime / SLA percentage contradiction check
  const slaContentMatch = content.match(/\b(\d{2,3}(?:\.\d+)?%)\s*(?:uptime|sla|availability)\b/i);
  if (slaContentMatch) {
    const claimedPct = slaContentMatch[1];
    const slaFact =
      approvedFacts.find((f) => /\b\d{2,3}(?:\.\d+)?%.*(?:uptime|sla|availability)\b/i.test(f.fact)) ||
      factChunks.find((c) => /\b\d{2,3}(?:\.\d+)?%.*(?:uptime|sla|availability)\b/i.test(c.excerpt));
    if (slaFact) {
      const sourceText = 'fact' in slaFact ? slaFact.fact : slaFact.excerpt;
      const verifiedPct = sourceText.match(/\b(\d{2,3}(?:\.\d+)?%)\b/);
      if (verifiedPct && verifiedPct[1] !== claimedPct) {
        issues.push({
          title: `Contradicted SLA Metric ("${slaContentMatch[0]}")`,
          category: 'Facts',
          severity: 'High',
          problematic_text: slaContentMatch[0],
          explanation: `Submitted metric "${slaContentMatch[0]}" contradicts approved SLA documentation (${verifiedPct[1]}).`,
          source_guideline_id: 'id' in slaFact ? slaFact.id : undefined,
          source_document: 'source' in slaFact ? slaFact.source : slaFact.source_document,
          supporting_guideline_excerpt: sourceText,
          page_or_section: 'page_or_section' in slaFact ? slaFact.page_or_section : `Fact ${slaFact.id}`,
          evidence_status: 'Contradicted',
          confidence_score: 96,
          suggested_correction: slaContentMatch[0].replace(claimedPct, verifiedPct[1]),
          confidence: 'High',
        });
      }
    }
  }

  // 4C. Quantitative statistical claims (e.g., "50,000 customers", "120 countries")
  const statRegex = /\b(\d+[\d,]*\+?|\d+k|\d+m)\s+(customers|clients|users|organizations|downloads|teams|countries|patents)\b/gi;
  let statMatch;
  while ((statMatch = statRegex.exec(content)) !== null) {
    const fullStat = statMatch[0];
    const verifiedFact = approvedFacts.find((af) => af.fact.toLowerCase().includes(fullStat.toLowerCase()));
    const verifiedChunk = factChunks.find((c) => c.excerpt.toLowerCase().includes(fullStat.toLowerCase()));

    if (!verifiedFact && !verifiedChunk) {
      issues.push({
        title: `Unverified Statistical Claim: "${fullStat}"`,
        category: 'Facts',
        severity: 'Medium',
        problematic_text: fullStat,
        explanation: `The quantitative claim "${fullStat}" has no supporting or contradicting record in indexed brand documents or approved facts. Verification evidence is required before publication.`,
        source_guideline_id: undefined,
        source_document: 'No Indexed Source Found',
        supporting_guideline_excerpt:
          'No supporting evidence found in indexed organisation documents or approved facts.',
        page_or_section: 'Unverified Statistical Claim',
        evidence_status: 'Unverified',
        confidence_score: 38,
        suggested_correction: 'numerous enterprise client partners',
        confidence: 'Unverified',
      });
    }
  }

  // 5. Retrieved policy chunk check: flag explicit banned keywords extracted from ingested RAG documents (e.g. "banned phrase:" or "never say" lines)
  for (const ev of retrievedEvidence) {
    if (ev.source_type !== 'document_chunk') continue;
    const prohibitionLines = ev.excerpt.matchAll(/(?:prohibit(?:ed)?|forbidden|do not use|never use|avoid using)\s*(?:phrase|term|word)?\s*[:\-]\s*["']([^"'\n]{3,60})["']/gi);
    for (const pm of prohibitionLines) {
      const banned = pm[1].trim();
      const idx = content.toLowerCase().indexOf(banned.toLowerCase());
      if (idx !== -1) {
        const matchedSlice = content.slice(idx, idx + banned.length);
        const dup = issues.some((i) => i.problematic_text.toLowerCase() === matchedSlice.toLowerCase());
        if (!dup) {
          issues.push({
            title: `Indexed Document Policy Violation: "${matchedSlice}"`,
            category: 'Messaging',
            severity: 'High',
            problematic_text: matchedSlice,
            explanation: `Matches prohibition documented in ${ev.source_document} (${ev.page_or_section}).`,
            source_guideline_id: ev.id,
            source_document: ev.source_document,
            supporting_guideline_excerpt: ev.excerpt,
            page_or_section: ev.page_or_section,
            evidence_status: 'Contradicted',
            confidence_score: 92,
            suggested_correction: 'revise phrasing to align with cited document policy',
            confidence: 'High',
          });
        }
      }
    }
  }

  let score = 100;
  for (const issue of issues) {
    if (issue.severity === 'High') score -= 22;
    else if (issue.severity === 'Medium') score -= 14;
    else score -= 8;
  }
  score = Math.max(10, Math.min(100, score));

  return {
    compliance_score: score,
    overall_summary:
      issues.length === 0
        ? 'Content aligns with retrieved brand guidelines, verified corporate facts, and approved terminology.'
        : `Identified ${issues.length} evidence-grounded governance finding(s) requiring creator review or approval.`,
    issues,
    used_ai: false,
  };
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
