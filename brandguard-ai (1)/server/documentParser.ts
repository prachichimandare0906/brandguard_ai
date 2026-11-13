import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024; // 15 MB

export class DocumentValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

export interface ExtractedPage {
  pageNumber: number;
  sectionTitle?: string;
  text: string;
}

export interface ExtractedDocumentResult {
  text: string;
  pageCount: number;
  pages: ExtractedPage[];
  ocrUsed: boolean;
  ocrRequired: boolean;
  warnings: string[];
  format: 'pdf' | 'docx' | 'txt';
}

function detectFormat(fileName: string, mimeType?: string): 'pdf' | 'docx' | 'txt' {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const mime = (mimeType || '').toLowerCase();

  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (
    ext === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (ext === 'txt' || mime === 'text/plain' || ext === 'md' || mime === 'text/markdown') return 'txt';

  throw new DocumentValidationError(
    `Unsupported document format "${ext || mime || 'unknown'}". Supported formats: PDF (.pdf), Word (.docx), and Plain Text (.txt).`
  );
}

function inferSectionTitle(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const first = lines[0];
  if (first.startsWith('#')) {
    return first.replace(/^#+\s*/, '').slice(0, 90);
  }
  if (first.length <= 80 && !first.endsWith('.') && /^[A-Z0-9Section]/.test(first)) {
    return first;
  }
  return undefined;
}

function isLikelyBinaryGarbage(text: string): boolean {
  if (!text) return false;
  let controlCount = 0;
  const sample = text.slice(0, 2000);
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 65533) {
      controlCount++;
    }
  }
  return controlCount / Math.max(1, sample.length) > 0.25;
}

async function performPdfOcrWithGemini(fileBuffer: Buffer): Promise<{ pages: ExtractedPage[]; text: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: fileBuffer.toString('base64'),
              },
            },
            {
              text: 'Extract all legible text from this PDF accurately page by page. Prefix each page with "--- PAGE N ---". Return only extracted text without commentary.',
            },
          ],
        },
      ],
    });

    const ocrText = (response.text || '').trim();
    if (!ocrText) return null;

    const splitPages = ocrText.split(/---\s*PAGE\s+(\d+)\s*---/i);
    const pages: ExtractedPage[] = [];
    if (splitPages.length > 2) {
      for (let i = 1; i < splitPages.length; i += 2) {
        const pageNumber = Number(splitPages[i]) || Math.floor(i / 2) + 1;
        const pageBody = (splitPages[i + 1] || '').trim();
        if (pageBody) {
          pages.push({
            pageNumber,
            sectionTitle: inferSectionTitle(pageBody),
            text: pageBody,
          });
        }
      }
    } else {
      pages.push({
        pageNumber: 1,
        sectionTitle: inferSectionTitle(ocrText),
        text: ocrText,
      });
    }

    return { pages, text: pages.map((p) => p.text).join('\n\n') };
  } catch (err) {
    console.warn('Gemini multimodal OCR fallback failed:', err);
    return null;
  }
}

export async function extractTextFromFile(
  fileBuffer: Buffer,
  fileName: string,
  mimeType?: string
): Promise<ExtractedDocumentResult> {
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new DocumentValidationError('Uploaded file is empty (0 bytes).');
  }

  if (fileBuffer.length > MAX_DOCUMENT_BYTES) {
    throw new DocumentValidationError(
      `Document exceeds maximum allowed size of ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))}MB.`
    );
  }

  const format = detectFormat(fileName, mimeType);
  const warnings: string[] = [];

  if (format === 'txt') {
    const rawText = fileBuffer.toString('utf-8').trim();
    if (!rawText) {
      throw new DocumentValidationError('Text document contains no readable content.');
    }
    if (isLikelyBinaryGarbage(rawText)) {
      throw new DocumentValidationError('File appears to contain binary data rather than UTF-8 text.');
    }

    const blocks = rawText.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    const pages: ExtractedPage[] = [];
    let currentTitle = inferSectionTitle(rawText) || 'Document Body';

    for (const block of blocks) {
      const maybeHeading = block.startsWith('#') || (block.length < 75 && !block.endsWith('.'));
      if (maybeHeading) {
        currentTitle = block.replace(/^#+\s*/, '').trim();
      }
      pages.push({
        pageNumber: 1,
        sectionTitle: currentTitle,
        text: block,
      });
    }

    return {
      text: rawText,
      pageCount: 1,
      pages: pages.length > 0 ? pages : [{ pageNumber: 1, sectionTitle: 'Document Body', text: rawText }],
      ocrUsed: false,
      ocrRequired: false,
      warnings,
      format,
    };
  }

  if (format === 'docx') {
    try {
      const [rawRes, htmlRes] = await Promise.all([
        mammoth.extractRawText({ buffer: fileBuffer }),
        mammoth.convertToHtml({ buffer: fileBuffer }),
      ]);

      const plainText = (rawRes.value || '').trim();
      if (!plainText) {
        throw new DocumentValidationError('DOCX file contains no extractable text.');
      }

      // Extract sections by heading tags from HTML when present
      const sectionMatches = htmlRes.value
        .replace(/<\/(p|h1|h2|h3|h4|li|tr)>/gi, '\n')
        .replace(/<h[1-4][^>]*>(.*?)<\/h[1-4]>/gi, (_m, inner) => `\n## ${inner.replace(/<[^>]+>/g, '').trim()}\n`)
        .replace(/<[^>]+>/g, '')
        .trim();

      const lines = (sectionMatches || plainText).split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const pages: ExtractedPage[] = [];
      let currentTitle = 'Overview';
      let currentLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('## ')) {
          if (currentLines.length > 0) {
            pages.push({
              pageNumber: 1,
              sectionTitle: currentTitle,
              text: currentLines.join('\n'),
            });
            currentLines = [];
          }
          currentTitle = line.replace(/^##\s*/, '').slice(0, 90);
        } else {
          currentLines.push(line);
        }
      }
      if (currentLines.length > 0) {
        pages.push({
          pageNumber: 1,
          sectionTitle: currentTitle,
          text: currentLines.join('\n'),
        });
      }

      return {
        text: plainText,
        pageCount: 1,
        pages: pages.length > 0 ? pages : [{ pageNumber: 1, sectionTitle: 'Document Body', text: plainText }],
        ocrUsed: false,
        ocrRequired: false,
        warnings,
        format,
      };
    } catch (err: any) {
      if (err instanceof DocumentValidationError) throw err;
      throw new DocumentValidationError(`Unable to parse DOCX document: ${err?.message || 'corrupted archive'}`);
    }
  }

  // PDF extraction via pdf-parse v2 PDFParse class
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: fileBuffer });
    const textResult = await parser.getText();
    const pages: ExtractedPage[] = (textResult.pages || [])
      .map((p) => {
        const clean = (p.text || '').trim();
        return {
          pageNumber: p.num || 1,
          sectionTitle: inferSectionTitle(clean),
          text: clean,
        };
      })
      .filter((p) => p.text.length > 0);

    const combinedText = (textResult.text || pages.map((p) => p.text).join('\n\n')).trim();
    const nonWsLength = combinedText.replace(/\s+/g, '').length;

    if (nonWsLength >= 40) {
      return {
        text: combinedText,
        pageCount: textResult.total || pages.length || 1,
        pages:
          pages.length > 0
            ? pages
            : [{ pageNumber: 1, sectionTitle: inferSectionTitle(combinedText), text: combinedText }],
        ocrUsed: false,
        ocrRequired: false,
        warnings,
        format,
      };
    }

    // Scanned / image-only PDF detected
    const ocrResult = await performPdfOcrWithGemini(fileBuffer);
    if (ocrResult && ocrResult.text.replace(/\s+/g, '').length >= 10) {
      return {
        text: ocrResult.text,
        pageCount: textResult.total || ocrResult.pages.length || 1,
        pages: ocrResult.pages,
        ocrUsed: true,
        ocrRequired: false,
        warnings: ['PDF contained no native text layer; automated OCR via Gemini multimodal was applied.'],
        format,
      };
    }

    warnings.push(
      'PDF appears scanned or image-only with insufficient extractable text. Configure GEMINI_API_KEY for automated OCR or upload a text-searchable PDF/DOCX/TXT.'
    );
    return {
      text: combinedText,
      pageCount: textResult.total || 1,
      pages: pages.length > 0 ? pages : [],
      ocrUsed: false,
      ocrRequired: true,
      warnings,
      format,
    };
  } catch (err: any) {
    // Attempt Gemini OCR even if PDF structure triggered parser fallback
    const ocrResult = await performPdfOcrWithGemini(fileBuffer);
    if (ocrResult && ocrResult.text.length >= 10) {
      return {
        text: ocrResult.text,
        pageCount: ocrResult.pages.length || 1,
        pages: ocrResult.pages,
        ocrUsed: true,
        ocrRequired: false,
        warnings: ['Standard PDF parser encountered structural warnings; OCR extraction completed via Gemini.'],
        format,
      };
    }

    throw new DocumentValidationError(
      `Unable to parse PDF file "${fileName}": ${err?.message || 'Invalid or corrupted PDF structure'}`
    );
  } finally {
    if (parser) {
      await parser.destroy().catch(() => undefined);
    }
  }
}
