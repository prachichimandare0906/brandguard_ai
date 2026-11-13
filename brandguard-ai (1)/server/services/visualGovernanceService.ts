import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DbAdapter } from '../db/types.js';
import { ObjectStorageService } from './objectStorage.js';

export class VisualValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'VisualValidationError';
  }
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
  aaNormalPass: boolean; // >= 4.5
  aaLargePass: boolean;  // >= 3.0
  aaaNormalPass: boolean; // >= 7.0
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
  dimensions: { width: number; height: number } | null;
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

const SUPPORTED_RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function normalizeHex(input: string): string | null {
  const raw = String(input || '').trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9A-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const norm = normalizeHex(hex) || '#000000';
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  return [r, g, b];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
      .join('')
  );
}

// Convert sRGB to CIE Lab for perceptual Delta-E (CIE76) color distance
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const rl = toLinear(r);
  const gl = toLinear(g);
  const bl = toLinear(b);

  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.0;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function calculateDeltaE(hexA: string, hexB: string): number {
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  const [L1, a1, b1Lab] = rgbToLab(r1, g1, b1);
  const [L2, a2, b2Lab] = rgbToLab(r2, g2, b2);
  return Math.sqrt((L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1Lab - b2Lab) ** 2);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  const linearize = (channel: number) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function calculateWcagContrast(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function suggestAccessibleForeground(
  fgHex: string,
  bgHex: string,
  approvedColors: string[],
  targetRatio = 4.5
): { hex: string; ratio: number } {
  // First check if any approved palette color meets >= targetRatio cleanly
  let bestApproved: { hex: string; ratio: number; dist: number } | null = null;
  for (const cand of approvedColors) {
    const norm = normalizeHex(cand);
    if (!norm) continue;
    const ratio = calculateWcagContrast(norm, bgHex);
    if (ratio >= targetRatio) {
      const dist = calculateDeltaE(fgHex, norm);
      if (!bestApproved || dist < bestApproved.dist) {
        bestApproved = { hex: norm, ratio, dist };
      }
    }
  }
  if (bestApproved) {
    return { hex: bestApproved.hex, ratio: bestApproved.ratio };
  }

  // Otherwise adjust foreground towards darker or lighter endpoint along RGB axis
  const [r, g, b] = hexToRgb(fgHex);
  const bgLum = relativeLuminance(bgHex);
  const stepTowardDark = bgLum > 0.35;

  for (let i = 1; i <= 40; i++) {
    const t = i / 40;
    const nr = stepTowardDark ? r * (1 - t) : r + (255 - r) * t;
    const ng = stepTowardDark ? g * (1 - t) : g + (255 - g) * t;
    const nb = stepTowardDark ? b * (1 - t) : b + (255 - b) * t;
    const cand = rgbToHex(nr, ng, nb);
    const ratio = calculateWcagContrast(cand, bgHex);
    if (ratio >= targetRatio) {
      return { hex: cand, ratio };
    }
  }

  const fallback = stepTowardDark ? '#0F172A' : '#FFFFFF';
  return { hex: fallback, ratio: calculateWcagContrast(fallback, bgHex) };
}

async function computeImageSignature(buffer: Buffer): Promise<{
  width: number;
  height: number;
  dHash: bigint;
  aHash: bigint;
  gridVec: number[];
  dominantColors: Array<{ hex: string; percentage: number }>;
}> {
  const image = sharp(buffer);
  const meta = await image.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width === 0 || height === 0) {
    throw new VisualValidationError('Uploaded image has zero dimensions or corrupted headers.');
  }

  // 1. 9x8 grayscale for difference hash (dHash) & average hash (aHash)
  const grayBuf = await sharp(buffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

  let dHash = 0n;
  let bitIndex = 0n;
  let sum = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = grayBuf[y * 9 + x];
      const right = grayBuf[y * 9 + x + 1];
      if (left > right) dHash |= 1n << bitIndex;
      sum += left;
      bitIndex += 1n;
    }
  }

  const avg = sum / 64;
  let aHash = 0n;
  bitIndex = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (grayBuf[y * 9 + x] >= avg) aHash |= 1n << bitIndex;
      bitIndex += 1n;
    }
  }

  // 2. 8x8 RGB grid vector for color structure comparison
  const rgbSmall = await sharp(buffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(8, 8, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();

  const gridVec: number[] = [];
  for (let i = 0; i < rgbSmall.length; i++) {
    gridVec.push(rgbSmall[i] / 255);
  }

  // 3. Dominant HEX extraction on 48x48 RGBA downsample
  const { data: rgba } = await sharp(buffer)
    .resize(48, 48, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map<string, { count: number; rSum: number; gSum: number; bSum: number }>();
  let totalPixels = 0;

  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];
    if (a < 128) continue; // skip transparent background

    totalPixels++;
    const br = Math.floor(r / 24);
    const bg = Math.floor(g / 24);
    const bb = Math.floor(b / 24);
    const key = `${br}-${bg}-${bb}`;
    const entry = buckets.get(key) || { count: 0, rSum: 0, gSum: 0, bSum: 0 };
    entry.count++;
    entry.rSum += r;
    entry.gSum += g;
    entry.bSum += b;
    buckets.set(key, entry);
  }

  const sortedBuckets = Array.from(buckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const dominantColors = sortedBuckets.map((entry) => ({
    hex: rgbToHex(entry.rSum / entry.count, entry.gSum / entry.count, entry.bSum / entry.count),
    percentage: Math.round((entry.count / Math.max(1, totalPixels)) * 100),
  }));

  return { width, height, dHash, aHash, gridVec, dominantColors };
}

function hammingSimilarity(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return Math.max(0, 1 - dist / 64);
}

function vectorCosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function resolveAssetBuffer(
  filePath: string,
  db: DbAdapter,
  storage: ObjectStorageService,
  orgId: string
): Promise<Buffer | null> {
  try {
    if (filePath.startsWith('/api/files/')) {
      const fileId = filePath.slice('/api/files/'.length);
      const row = await db.queryOne<{ storage_provider?: string; object_key?: string; data_base64?: string }>(
        'SELECT storage_provider, object_key, data_base64 FROM stored_files WHERE id = $1 AND org_id = $2',
        [fileId, orgId]
      );
      if (!row) return null;
      if (row.storage_provider === 's3' && row.object_key) {
        return await storage.downloadObject(row.object_key);
      }
      if (row.data_base64) {
        return Buffer.from(row.data_base64, 'base64');
      }
      return null;
    }

    if (filePath.startsWith('/assets/')) {
      const safeRel = path.basename(filePath);
      const localPath = path.resolve(process.cwd(), 'public', 'assets', safeRel);
      if (fs.existsSync(localPath)) {
        return fs.readFileSync(localPath);
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function extractFontsAndColorsFromMarkup(markup: string): {
  fonts: string[];
  colorPairs: Array<{ fg: string; bg: string; label: string }>;
  mentionedColors: string[];
} {
  const fonts = new Set<string>();
  const fontRegex = /font-family\s*[:=]\s*["']?([^;"'}>]+)["']?/gi;
  let m;
  while ((m = fontRegex.exec(markup)) !== null) {
    const rawList = m[1].split(',');
    for (const f of rawList) {
      const clean = f.replace(/["']/g, '').trim();
      if (clean && !['sans-serif', 'serif', 'monospace', 'system-ui', 'inherit'].includes(clean.toLowerCase())) {
        fonts.add(clean);
      }
    }
  }

  const mentionedColors = new Set<string>();
  const hexMatches = markup.match(/#[0-9a-fA-F]{3,6}\b/g) || [];
  for (const h of hexMatches) {
    const norm = normalizeHex(h);
    if (norm) mentionedColors.add(norm);
  }

  // Extract simple CSS foreground/background color pairs within blocks
  const colorPairs: Array<{ fg: string; bg: string; label: string }> = [];
  const blockRegex = /([^{}]*)\{([^}]+)\}/g;
  while ((m = blockRegex.exec(markup)) !== null) {
    const selector = (m[1] || 'CSS Rule').trim().slice(0, 40) || 'CSS Block';
    const body = m[2];
    const fgMatch = body.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,6})/i);
    const bgMatch = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/i);
    if (fgMatch && bgMatch) {
      const fg = normalizeHex(fgMatch[1]);
      const bg = normalizeHex(bgMatch[1]);
      if (fg && bg) {
        colorPairs.push({ fg, bg, label: `CSS (${selector})` });
      }
    }
  }

  return {
    fonts: Array.from(fonts),
    colorPairs,
    mentionedColors: Array.from(mentionedColors),
  };
}

export async function runVisualGovernanceAnalysis(params: {
  db: DbAdapter;
  storage: ObjectStorageService;
  orgId: string;
  userId: string;
  submissionId?: string | null;
  fileBuffer?: Buffer;
  fileName?: string;
  mimeType?: string;
  altText?: string;
  htmlOrCss?: string;
  foregroundHex?: string;
  backgroundHex?: string;
}): Promise<VisualAnalysisResult> {
  const {
    db,
    storage,
    orgId,
    userId,
    submissionId = null,
    fileBuffer,
    fileName = 'creative-asset',
    mimeType = '',
    altText = '',
    htmlOrCss = '',
    foregroundHex,
    backgroundHex,
  } = params;

  if (!fileBuffer && !htmlOrCss.trim() && !(foregroundHex && backgroundHex)) {
    throw new VisualValidationError(
      'Provide an image creative (PNG, JPG, JPEG, WEBP), SVG/HTML/CSS snippet, or foreground/background HEX pair.'
    );
  }

  if (fileBuffer) {
    if (fileBuffer.length === 0) {
      throw new VisualValidationError('Uploaded visual file is empty.');
    }
    if (fileBuffer.length > MAX_IMAGE_BYTES) {
      throw new VisualValidationError('Image file exceeds maximum 10MB size limit.');
    }
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (ext && !SUPPORTED_EXTENSIONS.has(ext) && !SUPPORTED_RASTER_MIMES.has(mimeType.toLowerCase()) && mimeType !== 'image/svg+xml') {
      throw new VisualValidationError(
        `Unsupported visual asset format "${ext || mimeType}". Allowed formats: PNG, JPG, JPEG, WEBP, SVG.`
      );
    }
  }

  // Load org brand settings & approved assets strictly for orgId
  const [orgRow, assetsRes] = await Promise.all([
    db.queryOne<{ brand_settings: any }>('SELECT brand_settings FROM organisations WHERE id = $1', [orgId]),
    db.query<{ id: string; asset_name: string; asset_type: string; file_path: string; guidelines: string }>(
      'SELECT * FROM assets WHERE org_id = $1',
      [orgId]
    ),
  ]);

  let parsedSettings: OrgBrandSettings = {
    primaryColors: ['#0F172A', '#0D9488', '#F8FAFC'],
    approvedFonts: ['Plus Jakarta Sans', 'JetBrains Mono'],
  };
  if (orgRow?.brand_settings) {
    try {
      const s = typeof orgRow.brand_settings === 'string' ? JSON.parse(orgRow.brand_settings) : orgRow.brand_settings;
      if (Array.isArray(s.primaryColors) && s.primaryColors.length > 0) {
        parsedSettings.primaryColors = s.primaryColors.map((c: string) => normalizeHex(c)).filter(Boolean) as string[];
      }
      if (Array.isArray(s.approvedFonts) && s.approvedFonts.length > 0) {
        parsedSettings.approvedFonts = s.approvedFonts.map((f: string) => String(f).trim()).filter(Boolean);
      }
    } catch {
      // keep defaults
    }
  }

  // Also include HEX values & typography declared in assets table
  const approvedColorSet = new Set<string>(parsedSettings.primaryColors);
  const approvedFontSet = new Set<string>(parsedSettings.approvedFonts.map((f) => f.toLowerCase()));
  for (const a of assetsRes.rows) {
    if (a.asset_type === 'Color Palette') {
      for (const token of a.file_path.split(',')) {
        const norm = normalizeHex(token);
        if (norm) approvedColorSet.add(norm);
      }
    } else if (a.asset_type === 'Typography') {
      for (const f of a.file_path.replace(/^Google Fonts:/i, '').split(',')) {
        const clean = f.replace(/for.*$/i, '').trim().toLowerCase();
        if (clean) approvedFontSet.add(clean);
      }
    }
  }
  const approvedColors = Array.from(approvedColorSet);

  const findings: VisualFinding[] = [];
  const limitations: string[] = [];
  let dimensions: { width: number; height: number } | null = null;
  let extractedColors: ExtractedColor[] = [];
  let logoSimilarityScore: number | null = null;
  let matchedLogoAssetId: string | null = null;
  let matchedLogoName: string | null = null;
  let matchedLogoPath: string | null = null;
  let storedFileId: string | null = null;
  let imageUrl: string | null = null;
  let effectiveMarkup = htmlOrCss || '';

  // Persist uploaded visual creative privately under orgId
  const now = new Date().toISOString();
  if (fileBuffer) {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const isSvg = ext === 'svg' || mimeType === 'image/svg+xml';
    if (isSvg) {
      effectiveMarkup += '\n' + fileBuffer.toString('utf-8');
    }

    const fileId = `VISF-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const resolvedMime =
      mimeType || (isSvg ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');

    if (storage.isConfigured()) {
      const loc = await storage.uploadObject({
        orgId,
        fileId,
        fileName,
        mimeType: resolvedMime,
        buffer: fileBuffer,
      });
      await db.query(
        `INSERT INTO stored_files (id, org_id, storage_provider, bucket, object_key, filename, mime_type, size_bytes, sha256, data_base64, uploaded_by, created_at)
         VALUES ($1, $2, 's3', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          fileId,
          orgId,
          loc.bucket,
          loc.objectKey,
          fileName,
          resolvedMime,
          fileBuffer.length,
          sha256,
          db.dialect === 'postgres' ? null : '',
          userId,
          now,
        ]
      );
      storedFileId = fileId;
      imageUrl = `/api/files/${fileId}`;
    } else if (db.dialect === 'sqlite' && process.env.NODE_ENV !== 'production') {
      await db.query(
        `INSERT INTO stored_files (id, org_id, storage_provider, bucket, object_key, filename, mime_type, size_bytes, sha256, data_base64, uploaded_by, created_at)
         VALUES ($1, $2, 'sqlite_dev', NULL, NULL, $3, $4, $5, $6, $7, $8, $9)`,
        [fileId, orgId, fileName, resolvedMime, fileBuffer.length, sha256, fileBuffer.toString('base64'), userId, now]
      );
      storedFileId = fileId;
      imageUrl = `/api/files/${fileId}`;
    }

    // Real raster pixel analysis via sharp
    if (!isSvg) {
      try {
        const sig = await computeImageSignature(fileBuffer);
        dimensions = { width: sig.width, height: sig.height };

        // Brand palette distance calculation
        extractedColors = sig.dominantColors.map((dc) => {
          let nearestHex = approvedColors[0] || '#0F172A';
          let minDelta = Infinity;
          for (const appHex of approvedColors) {
            const d = calculateDeltaE(dc.hex, appHex);
            if (d < minDelta) {
              minDelta = d;
              nearestHex = appHex;
            }
          }
          // Treat near-white / near-black neutrals gently unless stark deviation
          const isOnBrand = minDelta <= 28;
          return {
            hex: dc.hex,
            percentage: dc.percentage,
            nearestApprovedHex: nearestHex,
            deltaE: Number(minDelta.toFixed(1)),
            isOnBrand,
          };
        });

        const offBrandDominant = extractedColors.filter((c) => !c.isOnBrand && c.percentage >= 12);
        for (const off of offBrandDominant) {
          findings.push({
            id: `VF-COL-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
            category: 'Brand Color',
            severity: off.deltaE > 50 ? 'High' : 'Medium',
            title: `Off-Brand Dominant Colour Detected (${off.hex})`,
            explanation: `Extracted creative color ${off.hex} (${off.percentage}% visual area) diverges perceptually (Delta-E ${off.deltaE}) from the approved ${approvedColors.join(', ')} palette.`,
            suggested_fix: `Replace ${off.hex} with nearest approved brand swatch ${off.nearestApprovedHex}.`,
            evidence: `Pixel quantization: ${off.hex} (${off.percentage}% coverage), Delta-E=${off.deltaE} vs ${off.nearestApprovedHex}`,
          });
        }

        // Logo comparison against org's approved Logo assets
        const logoAssets = assetsRes.rows.filter((a) => a.asset_type === 'Logo');
        if (logoAssets.length > 0) {
          let bestScore = -1;
          let bestAsset: (typeof logoAssets)[0] | null = null;

          for (const logo of logoAssets) {
            const logoBuf = await resolveAssetBuffer(logo.file_path, db, storage, orgId);
            if (!logoBuf) continue;
            try {
              const refSig = await computeImageSignature(logoBuf);
              const dSim = hammingSimilarity(sig.dHash, refSig.dHash);
              const aSim = hammingSimilarity(sig.aHash, refSig.aHash);
              const rgbSim = vectorCosine(sig.gridVec, refSig.gridVec);
              const scorePct = Math.round((dSim * 0.4 + aSim * 0.25 + rgbSim * 0.35) * 100);
              if (scorePct > bestScore) {
                bestScore = scorePct;
                bestAsset = logo;
              }
            } catch {
              // ignore un-decodable logo (e.g. non-raster SVG reference)
            }
          }

          if (bestAsset && bestScore >= 0) {
            logoSimilarityScore = bestScore;
            matchedLogoAssetId = bestAsset.id;
            matchedLogoName = bestAsset.asset_name;
            matchedLogoPath = bestAsset.file_path;

            if (bestScore < 65) {
              findings.push({
                id: `VF-LOGO-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
                category: 'Logo Usage',
                severity: bestScore < 45 ? 'High' : 'Medium',
                title: `Low Logo Similarity vs "${bestAsset.asset_name}" (${bestScore}%)`,
                explanation: `Perceptual hash & structural color comparison against approved mark "${bestAsset.asset_name}" scored ${bestScore}%, indicating potential logo modification, distortion, or unapproved graphic usage.`,
                suggested_fix: `Use the unmodified "${bestAsset.asset_name}" master asset with clear space per ${bestAsset.guidelines || 'brand standards'}.`,
                evidence: `Perceptual dHash/aHash/RGB similarity: ${bestScore}% vs ${bestAsset.id}`,
              });
            }
          } else {
            limitations.push(
              'Approved reference logo files could not be raster-decoded for pixel similarity comparison.'
            );
          }
        } else {
          limitations.push('No approved Logo asset uploaded for this organisation; logo similarity skipped.');
        }

        if (!effectiveMarkup.trim()) {
          limitations.push(
            'Typography families cannot be reliably extracted from flattened raster pixels without HTML/CSS/SVG metadata.'
          );
        }
      } catch (err: any) {
        if (err instanceof VisualValidationError) throw err;
        throw new VisualValidationError(`Invalid or corrupted image file: ${err?.message || 'decode failure'}`);
      }
    }
  }

  // Markup / Typography / Mentioned Color inspection (HTML/CSS/SVG)
  const detectedFonts: Array<{ family: string; approved: boolean }> = [];
  const wcagResults: WcagPairResult[] = [];

  if (effectiveMarkup.trim()) {
    const parsedMarkup = extractFontsAndColorsFromMarkup(effectiveMarkup);
    for (const fam of parsedMarkup.fonts) {
      const isApproved = approvedFontSet.has(fam.toLowerCase());
      detectedFonts.push({ family: fam, approved: isApproved });
      if (!isApproved) {
        findings.push({
          id: `VF-FONT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          category: 'Typography',
          severity: 'Medium',
          title: `Unapproved Font Family: "${fam}"`,
          explanation: `Declared font "${fam}" is not in the approved typography standard (${parsedSettings.approvedFonts.join(', ')}).`,
          suggested_fix: `Change font-family declaration to "${parsedSettings.approvedFonts[0] || 'Plus Jakarta Sans'}".`,
          evidence: `CSS/SVG font-family="${fam}"`,
        });
      }
    }

    for (const hex of parsedMarkup.mentionedColors) {
      if (extractedColors.some((c) => c.hex === hex)) continue;
      let nearestHex = approvedColors[0] || '#0F172A';
      let minDelta = Infinity;
      for (const appHex of approvedColors) {
        const d = calculateDeltaE(hex, appHex);
        if (d < minDelta) {
          minDelta = d;
          nearestHex = appHex;
        }
      }
      const isOnBrand = minDelta <= 28;
      extractedColors.push({
        hex,
        percentage: 0,
        nearestApprovedHex: nearestHex,
        deltaE: Number(minDelta.toFixed(1)),
        isOnBrand,
      });
      if (!isOnBrand) {
        findings.push({
          id: `VF-MCOL-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          category: 'Brand Color',
          severity: 'Medium',
          title: `Off-Brand Markup HEX Colour (${hex})`,
          explanation: `Color ${hex} in HTML/CSS/SVG diverges (Delta-E ${minDelta.toFixed(1)}) from approved palette ${approvedColors.join(', ')}.`,
          suggested_fix: `Replace ${hex} with ${nearestHex}.`,
          evidence: `Markup HEX=${hex}, nearest=${nearestHex}`,
        });
      }
    }

    for (const pair of parsedMarkup.colorPairs) {
      const ratio = calculateWcagContrast(pair.fg, pair.bg);
      const aaNormal = ratio >= 4.5;
      const fix = !aaNormal ? suggestAccessibleForeground(pair.fg, pair.bg, approvedColors, 4.5) : undefined;
      wcagResults.push({
        label: pair.label,
        foregroundHex: pair.fg,
        backgroundHex: pair.bg,
        contrastRatio: ratio,
        aaNormalPass: aaNormal,
        aaLargePass: ratio >= 3.0,
        aaaNormalPass: ratio >= 7.0,
        suggestedForegroundHex: fix?.hex,
        suggestedContrastRatio: fix?.ratio,
        source: 'CSS/SVG Markup',
      });
    }
  }

  // Explicit Foreground / Background WCAG 2.1 Check
  const normFg = foregroundHex ? normalizeHex(foregroundHex) : null;
  const normBg = backgroundHex ? normalizeHex(backgroundHex) : null;
  if (normFg && normBg) {
    const ratio = calculateWcagContrast(normFg, normBg);
    const aaNormal = ratio >= 4.5;
    const fix = !aaNormal ? suggestAccessibleForeground(normFg, normBg, approvedColors, 4.5) : undefined;
    wcagResults.push({
      label: 'Declared Creative Foreground / Background Pair',
      foregroundHex: normFg,
      backgroundHex: normBg,
      contrastRatio: ratio,
      aaNormalPass: aaNormal,
      aaLargePass: ratio >= 3.0,
      aaaNormalPass: ratio >= 7.0,
      suggestedForegroundHex: fix?.hex,
      suggestedContrastRatio: fix?.ratio,
      source: 'Submitted Contrast Pair',
    });
  } else if (wcagResults.length === 0 && extractedColors.length >= 2) {
    // Compare primary two extracted colors as heuristic creative contrast
    const bg = extractedColors[0].hex;
    const fg = extractedColors[1].hex;
    const ratio = calculateWcagContrast(fg, bg);
    const aaNormal = ratio >= 4.5;
    const fix = !aaNormal ? suggestAccessibleForeground(fg, bg, approvedColors, 4.5) : undefined;
    wcagResults.push({
      label: 'Primary Dominant Image Tones Contrast',
      foregroundHex: fg,
      backgroundHex: bg,
      contrastRatio: ratio,
      aaNormalPass: aaNormal,
      aaLargePass: ratio >= 3.0,
      aaaNormalPass: ratio >= 7.0,
      suggestedForegroundHex: fix?.hex,
      suggestedContrastRatio: fix?.ratio,
      source: 'Dominant Image Tones Heuristic',
    });
  }

  for (const w of wcagResults) {
    if (!w.aaNormalPass) {
      findings.push({
        id: `VF-WCAG-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
        category: 'WCAG Contrast',
        severity: !w.aaLargePass ? 'High' : 'Medium',
        title: `WCAG 2.1 AA Contrast Failure (${w.contrastRatio}:1)`,
        explanation: `${w.label} (${w.foregroundHex} on ${w.backgroundHex}) achieves ${w.contrastRatio}:1 contrast ratio, failing WCAG 2.1 AA minimum 4.5:1 for normal text${
          !w.aaLargePass ? ' and 3.0:1 for large text' : ''
        }.`,
        suggested_fix: w.suggestedForegroundHex
          ? `Use ${w.suggestedForegroundHex} on ${w.backgroundHex} to achieve ${w.suggestedContrastRatio}:1 WCAG AA compliance.`
          : 'Increase luminance contrast between foreground text and background to at least 4.5:1.',
        evidence: `WCAG 2.1 ratio=${w.contrastRatio}:1 (${w.source})`,
      });
    }
  }

  // Alt text validation (required when an image file is uploaded)
  const cleanAlt = String(altText || '').trim();
  if (fileBuffer) {
    if (!cleanAlt) {
      findings.push({
        id: `VF-ALT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
        category: 'Accessibility',
        severity: 'High',
        title: 'Missing Descriptive Image Alt Text',
        explanation:
          'Uploaded visual creative has empty alt text. Accessible enterprise publishing requires descriptive alternative text for screen readers and WCAG 2.1 compliance.',
        suggested_fix: 'Add clear, concise alt text describing the visual purpose and any embedded headline text.',
        evidence: 'alt_text="" (0 characters)',
      });
    } else if (cleanAlt.length < 8 || /\.(png|jpe?g|webp|svg|gif)$/i.test(cleanAlt)) {
      findings.push({
        id: `VF-ALT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
        category: 'Accessibility',
        severity: 'Medium',
        title: 'Insufficient or Filename-Only Image Alt Text',
        explanation: `Provided alt text "${cleanAlt}" is either too brief or mirrors a raw filename instead of describing visual meaning.`,
        suggested_fix: 'Write a descriptive sentence (e.g., "Brand product architecture diagram showing secure deployment").',
        evidence: `alt_text="${cleanAlt}"`,
      });
    }
  }

  let overallScore = 100;
  for (const f of findings) {
    if (f.severity === 'High') overallScore -= 24;
    else if (f.severity === 'Medium') overallScore -= 14;
    else overallScore -= 6;
  }
  overallScore = Math.max(10, Math.min(100, overallScore));

  const analysisId = `VIS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await db.query(
    `INSERT INTO visual_analyses (id, org_id, submission_id, asset_name, mime_type, stored_file_id, alt_text, extracted_colors_json, detected_fonts_json, logo_similarity_score, matched_logo_asset_id, wcag_results_json, findings_json, limitations_json, overall_score, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      analysisId,
      orgId,
      submissionId,
      fileName,
      mimeType || 'image/png',
      storedFileId,
      cleanAlt,
      JSON.stringify(extractedColors),
      JSON.stringify(detectedFonts),
      logoSimilarityScore,
      matchedLogoAssetId,
      JSON.stringify(wcagResults),
      JSON.stringify(findings),
      JSON.stringify(limitations),
      overallScore,
      userId,
      now,
    ]
  );

  return {
    id: analysisId,
    org_id: orgId,
    submission_id: submissionId,
    asset_name: fileName,
    mime_type: mimeType || 'image/png',
    stored_file_id: storedFileId,
    image_url: imageUrl,
    dimensions,
    alt_text: cleanAlt,
    extracted_colors: extractedColors,
    detected_fonts: detectedFonts,
    logo_similarity_score: logoSimilarityScore,
    matched_logo_asset_id: matchedLogoAssetId,
    matched_logo_name: matchedLogoName,
    matched_logo_path: matchedLogoPath,
    wcag_results: wcagResults,
    findings,
    limitations,
    overall_score: overallScore,
    created_at: now,
  };
}
