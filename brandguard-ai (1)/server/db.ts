import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export type DBInstance = Database.Database;

function hashPasswordForMigration(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function openDatabase(customPath?: string): DBInstance {
  const resolvedPath =
    customPath ||
    process.env.DATABASE_PATH ||
    path.resolve(process.cwd(), 'data', 'brandguard.db');

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const instance = new Database(resolvedPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  return instance;
}

function tableHasColumn(instance: DBInstance, tableName: string, columnName: string): boolean {
  const cols = instance.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === columnName);
}

function ensureBaseTables(instance: DBInstance) {
  instance.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('creator', 'brand_manager', 'admin')),
      avatar TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS organisations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      brand_settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organisation_members (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('creator', 'brand_manager', 'admin')),
      created_at TEXT NOT NULL,
      UNIQUE(org_id, user_id),
      FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_org_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(active_org_id) REFERENCES organisations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS guidelines (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      title TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('Tone', 'Terminology', 'Messaging', 'Facts', 'Claims', 'Visual identity', 'Accessibility')),
      description TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('High', 'Medium', 'Low')),
      source_document TEXT,
      prohibited_phrase TEXT,
      preferred_replacement TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approved_facts (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      fact TEXT NOT NULL,
      source TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS terminology (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      prohibited_term TEXT NOT NULL,
      preferred_term TEXT NOT NULL,
      explanation TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      asset_name TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      guidelines TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stored_files (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data_base64 TEXT NOT NULL,
      uploaded_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      original_content TEXT NOT NULL,
      content_type TEXT NOT NULL,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Draft', 'In Review', 'Needs Revision', 'Approved', 'Rejected')),
      compliance_score INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS compliance_issues (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      submission_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('High', 'Medium', 'Low')),
      problematic_text TEXT NOT NULL,
      explanation TEXT NOT NULL,
      source_guideline_id TEXT,
      suggested_correction TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'High',
      source_document TEXT,
      supporting_guideline_excerpt TEXT,
      page_or_section TEXT,
      evidence_status TEXT NOT NULL DEFAULT 'Unverified',
      confidence_score INTEGER NOT NULL DEFAULT 75,
      human_status TEXT NOT NULL DEFAULT 'Pending' CHECK(human_status IN ('Pending', 'Accepted', 'Rejected', 'Modified')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      submission_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('Approved', 'Rejected', 'Needs Revision')),
      comments TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY(reviewer_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS content_versions (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      submission_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT,
      change_summary TEXT,
      compliance_score INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS submission_comments (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      issue_id TEXT,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE,
      FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      actor_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rag_documents (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      stored_file_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 1,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      ocr_used INTEGER NOT NULL DEFAULT 0,
      indexing_status TEXT NOT NULL DEFAULT 'indexed' CHECK(indexing_status IN ('indexed', 'partial_ocr_needed', 'failed')),
      warnings TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(org_id, sha256),
      FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      page_number INTEGER NOT NULL DEFAULT 1,
      section_title TEXT,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      embedding_json TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES rag_documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS visual_analyses (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      submission_id TEXT,
      asset_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      stored_file_id TEXT,
      alt_text TEXT NOT NULL DEFAULT '',
      extracted_colors_json TEXT NOT NULL DEFAULT '[]',
      detected_fonts_json TEXT NOT NULL DEFAULT '[]',
      logo_similarity_score INTEGER,
      matched_logo_asset_id TEXT,
      wcag_results_json TEXT NOT NULL DEFAULT '[]',
      findings_json TEXT NOT NULL DEFAULT '[]',
      limitations_json TEXT NOT NULL DEFAULT '[]',
      overall_score INTEGER NOT NULL DEFAULT 100,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE CASCADE,
      FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE
    );
  `);
}

function runMigrations(instance: DBInstance) {
  const migrationId = '001_phase1_orgs_auth_audit';
  const existing = instance.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migrationId);
  if (!existing) {

  const now = new Date().toISOString();

  const applyMigration = instance.transaction(() => {
    // 1. Add missing columns to existing Round 2 tables safely
    const addOrgIdTables = [
      'guidelines',
      'approved_facts',
      'terminology',
      'assets',
      'submissions',
      'compliance_issues',
      'reviews',
      'content_versions',
    ];

    for (const tbl of addOrgIdTables) {
      if (!tableHasColumn(instance, tbl, 'org_id')) {
        instance.exec(`ALTER TABLE ${tbl} ADD COLUMN org_id TEXT;`);
      }
    }

    if (!tableHasColumn(instance, 'users', 'is_active')) {
      instance.exec(`ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`);
    }
    if (!tableHasColumn(instance, 'users', 'created_at')) {
      instance.exec(`ALTER TABLE users ADD COLUMN created_at TEXT;`);
    }
    if (!tableHasColumn(instance, 'users', 'last_login_at')) {
      instance.exec(`ALTER TABLE users ADD COLUMN last_login_at TEXT;`);
    }
    if (!tableHasColumn(instance, 'content_versions', 'created_by')) {
      instance.exec(`ALTER TABLE content_versions ADD COLUMN created_by TEXT;`);
    }
    if (!tableHasColumn(instance, 'content_versions', 'change_summary')) {
      instance.exec(`ALTER TABLE content_versions ADD COLUMN change_summary TEXT;`);
    }
    if (!tableHasColumn(instance, 'content_versions', 'compliance_score')) {
      instance.exec(`ALTER TABLE content_versions ADD COLUMN compliance_score INTEGER;`);
    }

    // 2. Ensure legacy Nova Tech organisation exists if there are legacy rows
    const legacyRowsCount =
      (instance.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c +
      (instance.prepare('SELECT COUNT(*) as c FROM submissions').get() as { c: number }).c +
      (instance.prepare('SELECT COUNT(*) as c FROM guidelines').get() as { c: number }).c;

    if (legacyRowsCount > 0) {
      instance
        .prepare(
          `INSERT OR IGNORE INTO organisations (id, name, slug, brand_settings, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          'org-novatech',
          'NOVA TECH',
          'nova-tech',
          JSON.stringify({
            primaryColors: ['#0F172A', '#0D9488', '#F8FAFC'],
            approvedFonts: ['Plus Jakarta Sans', 'JetBrains Mono'],
          }),
          now
        );

      // 3. Backfill org_id on all legacy records without dropping any Round 2 data
      for (const tbl of addOrgIdTables) {
        instance.prepare(`UPDATE ${tbl} SET org_id = 'org-novatech' WHERE org_id IS NULL`).run();
      }

      // 4. Fix legacy dev-only image URLs so production builds serve assets cleanly
      instance
        .prepare(
          `UPDATE assets
           SET file_path = '/assets/novatech_brand_logo.jpg'
           WHERE file_path LIKE '%novatech_brand_logo%'`
        )
        .run();
      instance
        .prepare(
          `UPDATE users
           SET avatar = '/assets/avatar_brand_manager.jpg'
           WHERE avatar LIKE '%avatar_brand_manager%'`
        )
        .run();

      // 5. Migrate existing users into organisation_members and scrub insecure mock password placeholders
      const legacyUsers = instance.prepare('SELECT id, role, password_hash, created_at FROM users').all() as Array<{
        id: string;
        role: string;
        password_hash: string;
        created_at?: string | null;
      }>;

      const bootstrapPassword = process.env.BOOTSTRAP_DEMO_PASSWORD?.trim();

      for (const u of legacyUsers) {
        instance
          .prepare(
            `INSERT OR IGNORE INTO organisation_members (id, org_id, user_id, role, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(`MEM-novatech-${u.id}`, 'org-novatech', u.id, u.role, now);

        if (!u.created_at) {
          instance.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(now, u.id);
        }

        if (u.password_hash && u.password_hash.startsWith('pbkdf2$e1$mockhashedpass')) {
          const replacementHash = bootstrapPassword
            ? hashPasswordForMigration(bootstrapPassword)
            : 'LOCKED_RESET_REQUIRED';
          instance.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(replacementHash, u.id);
        }
      }

      // 6. Backfill created_by on legacy content_versions from parent submissions
      instance
        .prepare(
          `UPDATE content_versions
           SET created_by = (SELECT s.created_by FROM submissions s WHERE s.id = content_versions.submission_id)
           WHERE created_by IS NULL`
        )
        .run();

      // 7. Record initial migration audit entry for Nova Tech
      instance
        .prepare(
          `INSERT INTO audit_logs (id, org_id, actor_id, actor_role, action, entity_type, entity_id, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `AUD-MIG-${Date.now()}`,
          'org-novatech',
          null,
          'system',
          'SCHEMA_MIGRATION_APPLIED',
          'organisation',
          'org-novatech',
          JSON.stringify({ migrationId, preservedLegacyData: true }),
          now
        );
    }

    // 8. Indexes for tenant-isolated queries & fast session lookups
    instance.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_org_members_user ON organisation_members(user_id, org_id);
      CREATE INDEX IF NOT EXISTS idx_guidelines_org ON guidelines(org_id);
      CREATE INDEX IF NOT EXISTS idx_facts_org ON approved_facts(org_id);
      CREATE INDEX IF NOT EXISTS idx_terminology_org ON terminology(org_id);
      CREATE INDEX IF NOT EXISTS idx_assets_org ON assets(org_id);
      CREATE INDEX IF NOT EXISTS idx_submissions_org ON submissions(org_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_issues_org_sub ON compliance_issues(org_id, submission_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_org_sub ON reviews(org_id, submission_id);
      CREATE INDEX IF NOT EXISTS idx_versions_org_sub ON content_versions(org_id, submission_id);
      CREATE INDEX IF NOT EXISTS idx_comments_org_sub ON submission_comments(org_id, submission_id);
      CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(org_id, created_at);
    `);

    instance
      .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
      .run(migrationId, 'Phase 1 multi-tenant orgs, scrypt auth sessions, and audit logs', now);
  });

  applyMigration();
  }

  const migration2Id = '002_stored_files_object_meta';
  const existing2 = instance.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migration2Id);
  if (!existing2) {
    const applyMigration2 = instance.transaction(() => {
      if (!tableHasColumn(instance, 'stored_files', 'storage_provider')) {
        instance.exec(`ALTER TABLE stored_files ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'sqlite_dev';`);
      }
      if (!tableHasColumn(instance, 'stored_files', 'bucket')) {
        instance.exec(`ALTER TABLE stored_files ADD COLUMN bucket TEXT;`);
      }
      if (!tableHasColumn(instance, 'stored_files', 'object_key')) {
        instance.exec(`ALTER TABLE stored_files ADD COLUMN object_key TEXT;`);
      }
      instance
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(migration2Id, 'Add object storage metadata columns to stored_files', new Date().toISOString());
    });
    applyMigration2();
  }

  const migration3Id = '003_phase2_3_rag_visual';
  const existing3 = instance.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migration3Id);
  if (!existing3) {
    const applyMigration3 = instance.transaction(() => {
      if (!tableHasColumn(instance, 'compliance_issues', 'source_document')) {
        instance.exec(`ALTER TABLE compliance_issues ADD COLUMN source_document TEXT;`);
      }
      if (!tableHasColumn(instance, 'compliance_issues', 'supporting_guideline_excerpt')) {
        instance.exec(`ALTER TABLE compliance_issues ADD COLUMN supporting_guideline_excerpt TEXT;`);
      }
      if (!tableHasColumn(instance, 'compliance_issues', 'page_or_section')) {
        instance.exec(`ALTER TABLE compliance_issues ADD COLUMN page_or_section TEXT;`);
      }
      if (!tableHasColumn(instance, 'compliance_issues', 'evidence_status')) {
        instance.exec(`ALTER TABLE compliance_issues ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'Unverified';`);
      }
      if (!tableHasColumn(instance, 'compliance_issues', 'confidence_score')) {
        instance.exec(`ALTER TABLE compliance_issues ADD COLUMN confidence_score INTEGER NOT NULL DEFAULT 75;`);
      }
      instance.exec(`
        CREATE INDEX IF NOT EXISTS idx_rag_documents_org ON rag_documents(org_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_document_chunks_org_doc ON document_chunks(org_id, document_id, chunk_index);
        CREATE INDEX IF NOT EXISTS idx_visual_analyses_org_sub ON visual_analyses(org_id, submission_id, created_at);
      `);
      instance
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(migration3Id, 'Round 3 RAG chunks, explainable evidence citations, and visual governance', new Date().toISOString());
    });
    applyMigration3();
  }
}

export function seedStarterWorkspaceForOrg(instance: DBInstance, orgId: string, creatorUserId: string, orgName: string) {
  const now = new Date().toISOString();
  const suffix = orgId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || Date.now().toString().slice(-6);

  const tx = instance.transaction(() => {
    const insertGuideline = instance.prepare(`
      INSERT INTO guidelines (id, org_id, title, category, description, severity, source_document, prohibited_phrase, preferred_replacement, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ruleToneId = `RULE-${suffix}-TONE-01`;
    const ruleTermId = `RULE-${suffix}-TERM-01`;
    const ruleClaim1Id = `RULE-${suffix}-CLAIM-01`;
    const ruleClaim2Id = `RULE-${suffix}-CLAIM-02`;
    const ruleFactId = `RULE-${suffix}-FACT-01`;
    const ruleAccId = `RULE-${suffix}-ACC-01`;
    const ruleVisId = `RULE-${suffix}-VIS-01`;
    const ruleMsgId = `RULE-${suffix}-MSG-01`;

    insertGuideline.run(
      ruleToneId,
      orgId,
      'Professional, Friendly & Informative Voice',
      'Tone',
      `${orgName} communicates in an authoritative, supportive, and informative manner. Avoid aggressive urgency, artificial scarcity, pushy hype, or sensationalist slogans.`,
      'Medium',
      'Brand_Voice_Policy_v2.4.pdf',
      'Buy now or miss out!',
      `Discover how ${orgName} can support your team today.`,
      now
    );
    insertGuideline.run(
      ruleTermId,
      orgId,
      'Refer to Clientele as Customers or Partners',
      'Terminology',
      'Always use "customers" or "partners" instead of "users" in public marketing, advertising, and external press communications.',
      'Medium',
      'Corporate_Glossary_2026.docx',
      'users',
      'customers',
      now
    );
    insertGuideline.run(
      ruleClaim1Id,
      orgId,
      'No Unsupported Performance Guarantees',
      'Claims',
      'Never promise guaranteed financial, operational, or latency outcomes without approved legal disclaimers and empirical test evidence.',
      'High',
      'Legal_Compliance_Standards.pdf',
      'guarantees results',
      'is designed to deliver measurable results',
      now
    );
    insertGuideline.run(
      ruleClaim2Id,
      orgId,
      'Prohibit Unsubstantiated Superlatives',
      'Claims',
      'Avoid superlative phrasing such as "the best ever", "#1 ranked", or "flawless" unless supported by named third-party analyst reports.',
      'High',
      'Brand_Voice_Policy_v2.4.pdf',
      'the best ever',
      'an industry-leading solution',
      now
    );
    insertGuideline.run(
      ruleFactId,
      orgId,
      'Ground Corporate Heritage in Verified Facts',
      'Facts',
      `All dates, metrics, and regional presence claims must match official ${orgName} records. Founded in 2018 with operations in India and Singapore.`,
      'High',
      'Fact_Sheet_Q1_2026.txt',
      null,
      null,
      now
    );
    insertGuideline.run(
      ruleAccId,
      orgId,
      'Accessibility & Descriptive Text Standards',
      'Accessibility',
      'All published graphical media must contain meaningful descriptive alt text and meet WCAG 2.1 AA contrast ratios.',
      'Medium',
      'Digital_Accessibility_Guidelines.pdf',
      null,
      null,
      now
    );
    insertGuideline.run(
      ruleVisId,
      orgId,
      'Approved Corporate Logo Usage',
      'Visual identity',
      'Only use the approved brand emblem. Do not distort, rotate, recolor into arbitrary gradients, or apply drop shadows.',
      'High',
      'Visual_Identity_Manual.pdf',
      null,
      null,
      now
    );
    insertGuideline.run(
      ruleMsgId,
      orgId,
      'Customer-Centric Value Messaging',
      'Messaging',
      'Focus copy on customer empowerment and transparent engineering. Refrain from disparaging competitors or fear-based claims.',
      'Medium',
      'Brand_Voice_Policy_v2.4.pdf',
      'competitor inferior',
      'proven industry architecture',
      now
    );

    const insertFact = instance.prepare(`
      INSERT INTO approved_facts (id, org_id, fact, source, verified_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertFact.run(`FACT-${suffix}-01`, orgId, `${orgName} was founded in 2018 in Bengaluru, India.`, 'Certificate of Incorporation (2018)', now, now);
    insertFact.run(`FACT-${suffix}-02`, orgId, `${orgName} enterprise cloud suite is officially available in India, Singapore, and North America.`, 'Corporate Market Directory Q1 2026', now, now);
    insertFact.run(`FACT-${suffix}-03`, orgId, `${orgName} holds active ISO/IEC 27001:2022 and SOC 2 Type II compliance certifications.`, 'Global Trust & Security Audit 2025', now, now);
    insertFact.run(`FACT-${suffix}-04`, orgId, `${orgName} infrastructure achieves 99.99% verified uptime SLA.`, 'Engineering SLA Quarterly Report', now, now);

    const insertTerm = instance.prepare(`
      INSERT INTO terminology (id, org_id, prohibited_term, preferred_term, explanation, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertTerm.run(`TERM-${suffix}-01`, orgId, 'users', 'customers', 'In outbound marketing, use "customers" or "partners" to build meaningful client rapport.', now);
    insertTerm.run(`TERM-${suffix}-02`, orgId, 'cheap', 'cost-effective', 'Preserve premium enterprise brand positioning by avoiding cheap or bargain language.', now);
    insertTerm.run(`TERM-${suffix}-03`, orgId, 'guarantees', 'is designed to deliver', 'Legal compliance requires avoiding uncertified performance guarantees.', now);
    insertTerm.run(`TERM-${suffix}-04`, orgId, 'best ever', 'industry-leading', 'Superlatives must be substantiated by licensed third-party benchmark reports.', now);
    insertTerm.run(`TERM-${suffix}-05`, orgId, 'hacky', 'innovative agile', 'Avoid informal engineering slang that undermines enterprise stability confidence.', now);

    const insertAsset = instance.prepare(`
      INSERT INTO assets (id, org_id, asset_name, asset_type, file_path, guidelines, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertAsset.run(
      `ASSET-${suffix}-01`,
      orgId,
      `${orgName} Primary Hexagon Mark`,
      'Logo',
      '/assets/novatech_brand_logo.jpg',
      'Use on clean light backgrounds with minimum 24px clear margin space on all sides.',
      now
    );
    insertAsset.run(
      `ASSET-${suffix}-02`,
      orgId,
      'Corporate Palette: Deep Navy (#0F172A) & Cyan Teal (#0D9488)',
      'Color Palette',
      '#0F172A, #0D9488, #F8FAFC',
      'Navy is 60% neutral baseline; Cyan Teal is 10% high-intent action accent.',
      now
    );
    insertAsset.run(
      `ASSET-${suffix}-03`,
      orgId,
      'Brand Typography: Plus Jakarta Sans',
      'Typography',
      'Google Fonts: Plus Jakarta Sans for titles/body, JetBrains Mono for metrics.',
      'Weights: 400 Regular for prose, 600 SemiBold for titles, 700 Bold for hero marks.',
      now
    );

    const subId = `SUB-${suffix}-001`;
    const sampleContent = `Attention users: ${orgName} is the best ever tool for workflow automation. Our software guarantees results within 48 hours! Sign up now or miss out on cheap monthly rates.`;
    instance
      .prepare(
        `INSERT INTO submissions (id, org_id, title, content, original_content, content_type, created_by, status, compliance_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Needs Revision', 42, ?, ?)`
      )
      .run(subId, orgId, 'Spring Promotional Email Campaign (Starter Sample)', sampleContent, sampleContent, 'Email Campaign', creatorUserId, now, now);

    instance
      .prepare(
        `INSERT INTO content_versions (id, org_id, submission_id, version_number, content, created_by, change_summary, compliance_score, created_at)
         VALUES (?, ?, ?, 1, ?, ?, 'Initial starter draft', 42, ?)`
      )
      .run(`VER-${subId}-1`, orgId, subId, sampleContent, creatorUserId, now);

    const insertIssue = instance.prepare(`
      INSERT INTO compliance_issues (id, org_id, submission_id, title, category, severity, problematic_text, explanation, source_guideline_id, suggested_correction, confidence, human_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'High', 'Pending', ?)
    `);
    insertIssue.run(`ISS-${subId}-1`, orgId, subId, 'Prohibited Terminology: "users"', 'Terminology', 'Medium', 'users', 'Corporate glossary dictates using "customers" or "partners" in external marketing.', ruleTermId, 'customers', now);
    insertIssue.run(`ISS-${subId}-2`, orgId, subId, 'Unsubstantiated Superlative', 'Claims', 'High', 'the best ever', 'Superlatives require official third-party research benchmark citations.', ruleClaim2Id, 'an industry-leading', now);
    insertIssue.run(`ISS-${subId}-3`, orgId, subId, 'Unsupported Performance Guarantee', 'Claims', 'High', 'guarantees results', 'Performance guarantees violate legal compliance guidelines without certified trial metrics.', ruleClaim1Id, 'is designed to deliver measurable results', now);
    insertIssue.run(`ISS-${subId}-4`, orgId, subId, 'Aggressive Scarcity & Cheap Phrasing', 'Tone', 'Medium', 'or miss out on cheap monthly rates', 'Violates professional tone guideline and premium market positioning.', ruleToneId, 'and explore our cost-effective monthly plans', now);
  });

  tx();
}

export function initDatabase(customPath?: string): DBInstance {
  const instance = openDatabase(customPath);
  ensureBaseTables(instance);
  runMigrations(instance);
  return instance;
}
