import { DbAdapter } from './types.js';

export async function seedStarterWorkspaceForOrg(
  db: DbAdapter,
  orgId: string,
  creatorUserId: string,
  orgName: string
): Promise<void> {
  const now = new Date().toISOString();
  const suffix = orgId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || Date.now().toString().slice(-6);

  await db.transaction(async (tx) => {
    const ruleToneId = `RULE-${suffix}-TONE-01`;
    const ruleTermId = `RULE-${suffix}-TERM-01`;
    const ruleClaim1Id = `RULE-${suffix}-CLAIM-01`;
    const ruleClaim2Id = `RULE-${suffix}-CLAIM-02`;
    const ruleFactId = `RULE-${suffix}-FACT-01`;
    const ruleAccId = `RULE-${suffix}-ACC-01`;
    const ruleVisId = `RULE-${suffix}-VIS-01`;
    const ruleMsgId = `RULE-${suffix}-MSG-01`;

    const insertGuidelineSql = `
      INSERT INTO guidelines (id, org_id, title, category, description, severity, source_document, prohibited_phrase, preferred_replacement, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    await tx.query(insertGuidelineSql, [
      ruleToneId,
      orgId,
      'Professional, Friendly & Informative Voice',
      'Tone',
      `${orgName} communicates in an authoritative, supportive, and informative manner. Avoid aggressive urgency, artificial scarcity, pushy hype, or sensationalist slogans.`,
      'Medium',
      'Brand_Voice_Policy_v2.4.pdf',
      'Buy now or miss out!',
      `Discover how ${orgName} can support your team today.`,
      now,
    ]);

    await tx.query(insertGuidelineSql, [
      ruleTermId,
      orgId,
      'Refer to Clientele as Customers or Partners',
      'Terminology',
      'Always use "customers" or "partners" instead of "users" in public marketing, advertising, and external press communications.',
      'Medium',
      'Corporate_Glossary_2026.docx',
      'users',
      'customers',
      now,
    ]);

    await tx.query(insertGuidelineSql, [
      ruleClaim1Id,
      orgId,
      'No Unsupported Performance Guarantees',
      'Claims',
      'Never promise guaranteed financial, operational, or latency outcomes without approved legal disclaimers and empirical test evidence.',
      'High',
      'Legal_Compliance_Standards.pdf',
      'guarantees results',
      'is designed to deliver measurable results',
      now,
    ]);

    await tx.query(insertGuidelineSql, [
      ruleClaim2Id,
      orgId,
      'Prohibit Unsubstantiated Superlatives',
      'Claims',
      'Avoid superlative phrasing such as "the best ever", "#1 ranked", or "flawless" unless supported by named third-party analyst reports.',
      'High',
      'Brand_Voice_Policy_v2.4.pdf',
      'the best ever',
      'an industry-leading solution',
      now,
    ]);

    await tx.query(insertGuidelineSql, [
      ruleFactId,
      orgId,
      'Ground Corporate Heritage in Verified Facts',
      'Facts',
      `All dates, metrics, and regional presence claims must match official ${orgName} records. Founded in 2018 with operations in India and Singapore.`,
      'High',
      'Fact_Sheet_Q1_2026.txt',
      null,
      null,
      now,
    ]);

    await tx.query(insertGuidelineSql, [
      ruleAccId,
      orgId,
      'Accessibility & Descriptive Text Standards',
      'Accessibility',
      'All published graphical media must contain meaningful descriptive alt text and meet WCAG 2.1 AA contrast ratios.',
      'Medium',
      'Digital_Accessibility_Guidelines.pdf',
      null,
      null,
      now,
    ]);

    await tx.query(insertGuidelineSql, [
      ruleVisId,
      orgId,
      'Approved Corporate Logo Usage',
      'Visual identity',
      'Only use the approved brand emblem. Do not distort, rotate, recolor into arbitrary gradients, or apply drop shadows.',
      'High',
      'Visual_Identity_Manual.pdf',
      null,
      null,
      now,
    ]);

    await tx.query(insertGuidelineSql, [
      ruleMsgId,
      orgId,
      'Customer-Centric Value Messaging',
      'Messaging',
      'Focus copy on customer empowerment and transparent engineering. Refrain from disparaging competitors or fear-based claims.',
      'Medium',
      'Brand_Voice_Policy_v2.4.pdf',
      'competitor inferior',
      'proven industry architecture',
      now,
    ]);

    const insertFactSql = `
      INSERT INTO approved_facts (id, org_id, fact, source, verified_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await tx.query(insertFactSql, [`FACT-${suffix}-01`, orgId, `${orgName} was founded in 2018 in Bengaluru, India.`, 'Certificate of Incorporation (2018)', now, now]);
    await tx.query(insertFactSql, [`FACT-${suffix}-02`, orgId, `${orgName} enterprise cloud suite is officially available in India, Singapore, and North America.`, 'Corporate Market Directory Q1 2026', now, now]);
    await tx.query(insertFactSql, [`FACT-${suffix}-03`, orgId, `${orgName} holds active ISO/IEC 27001:2022 and SOC 2 Type II compliance certifications.`, 'Global Trust & Security Audit 2025', now, now]);
    await tx.query(insertFactSql, [`FACT-${suffix}-04`, orgId, `${orgName} infrastructure achieves 99.99% verified uptime SLA.`, 'Engineering SLA Quarterly Report', now, now]);

    const insertTermSql = `
      INSERT INTO terminology (id, org_id, prohibited_term, preferred_term, explanation, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await tx.query(insertTermSql, [`TERM-${suffix}-01`, orgId, 'users', 'customers', 'In outbound marketing, use "customers" or "partners" to build meaningful client rapport.', now]);
    await tx.query(insertTermSql, [`TERM-${suffix}-02`, orgId, 'cheap', 'cost-effective', 'Preserve premium enterprise brand positioning by avoiding cheap or bargain language.', now]);
    await tx.query(insertTermSql, [`TERM-${suffix}-03`, orgId, 'guarantees', 'is designed to deliver', 'Legal compliance requires avoiding uncertified performance guarantees.', now]);
    await tx.query(insertTermSql, [`TERM-${suffix}-04`, orgId, 'best ever', 'industry-leading', 'Superlatives must be substantiated by licensed third-party benchmark reports.', now]);
    await tx.query(insertTermSql, [`TERM-${suffix}-05`, orgId, 'hacky', 'innovative agile', 'Avoid informal engineering slang that undermines enterprise stability confidence.', now]);

    const insertAssetSql = `
      INSERT INTO assets (id, org_id, asset_name, asset_type, file_path, guidelines, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await tx.query(insertAssetSql, [
      `ASSET-${suffix}-01`,
      orgId,
      `${orgName} Primary Hexagon Mark`,
      'Logo',
      '/assets/novatech_brand_logo.jpg',
      'Use on clean light backgrounds with minimum 24px clear margin space on all sides.',
      now,
    ]);
    await tx.query(insertAssetSql, [
      `ASSET-${suffix}-02`,
      orgId,
      'Corporate Palette: Deep Navy (#0F172A) & Cyan Teal (#0D9488)',
      'Color Palette',
      '#0F172A, #0D9488, #F8FAFC',
      'Navy is 60% neutral baseline; Cyan Teal is 10% high-intent action accent.',
      now,
    ]);
    await tx.query(insertAssetSql, [
      `ASSET-${suffix}-03`,
      orgId,
      'Brand Typography: Plus Jakarta Sans',
      'Typography',
      'Google Fonts: Plus Jakarta Sans for titles/body, JetBrains Mono for metrics.',
      'Weights: 400 Regular for prose, 600 SemiBold for titles, 700 Bold for hero marks.',
      now,
    ]);

    const subId = `SUB-${suffix}-001`;
    const sampleContent = `Attention users: ${orgName} is the best ever tool for workflow automation. Our software guarantees results within 48 hours! Sign up now or miss out on cheap monthly rates.`;
    await tx.query(
      `INSERT INTO submissions (id, org_id, title, content, original_content, content_type, created_by, status, compliance_score, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Needs Revision', 42, $8, $9)`,
      [subId, orgId, 'Spring Promotional Email Campaign (Starter Sample)', sampleContent, sampleContent, 'Email Campaign', creatorUserId, now, now]
    );

    await tx.query(
      `INSERT INTO content_versions (id, org_id, submission_id, version_number, content, created_by, change_summary, compliance_score, created_at)
       VALUES ($1, $2, $3, 1, $4, $5, 'Initial starter draft', 42, $6)`,
      [`VER-${subId}-1`, orgId, subId, sampleContent, creatorUserId, now]
    );

    const insertIssueSql = `
      INSERT INTO compliance_issues (id, org_id, submission_id, title, category, severity, problematic_text, explanation, source_guideline_id, suggested_correction, confidence, human_status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'High', 'Pending', $11)
    `;
    await tx.query(insertIssueSql, [`ISS-${subId}-1`, orgId, subId, 'Prohibited Terminology: "users"', 'Terminology', 'Medium', 'users', 'Corporate glossary dictates using "customers" or "partners" in external marketing.', ruleTermId, 'customers', now]);
    await tx.query(insertIssueSql, [`ISS-${subId}-2`, orgId, subId, 'Unsubstantiated Superlative', 'Claims', 'High', 'the best ever', 'Superlatives require official third-party research benchmark citations.', ruleClaim2Id, 'an industry-leading', now]);
    await tx.query(insertIssueSql, [`ISS-${subId}-3`, orgId, subId, 'Unsupported Performance Guarantee', 'Claims', 'High', 'guarantees results', 'Performance guarantees violate legal compliance guidelines without certified trial metrics.', ruleClaim1Id, 'is designed to deliver measurable results', now]);
    await tx.query(insertIssueSql, [`ISS-${subId}-4`, orgId, subId, 'Aggressive Scarcity & Cheap Phrasing', 'Tone', 'Medium', 'or miss out on cheap monthly rates', 'Violates professional tone guideline and premium market positioning.', ruleToneId, 'and explore our cost-effective monthly plans', now]);
  });
}
