import { GoogleGenAI } from '@google/genai';

export const LOCAL_EMBEDDING_MODEL = 'local-lexical-256';
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';
const LOCAL_DIM = 256;

export interface EmbeddingVectorResult {
  vector: number[];
  model: string;
}

export function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function normalizeVector(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

function fnv1aHash(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function computeLocalLexicalEmbedding(text: string): number[] {
  const vec = new Array<number>(LOCAL_DIM).fill(0);
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9%$#.\s-]/g, ' ')
    .trim();

  if (!clean) return vec;

  const words = clean.split(/\s+/).filter((w) => w.length >= 2);
  for (const w of words) {
    const idx = fnv1aHash(`w:${w}`) % LOCAL_DIM;
    vec[idx] += 2.0;

    // Add character 3-gram features for morphological similarity
    if (w.length >= 3) {
      for (let i = 0; i <= w.length - 3; i++) {
        const tri = w.slice(i, i + 3);
        const triIdx = fnv1aHash(`g:${tri}`) % LOCAL_DIM;
        vec[triIdx] += 0.65;
      }
    }
  }

  return normalizeVector(vec);
}

export async function embedText(text: string): Promise<EmbeddingVectorResult> {
  const results = await embedTexts([text]);
  return results[0];
}

export async function embedTexts(texts: string[]): Promise<EmbeddingVectorResult[]> {
  if (texts.length === 0) return [];

  const ai = createGeminiClient();
  if (ai) {
    try {
      const response = await ai.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: texts,
      });

      const embeddings = response.embeddings || [];
      if (embeddings.length === texts.length && embeddings.every((e) => Array.isArray(e.values) && e.values.length > 0)) {
        return embeddings.map((e) => ({
          vector: normalizeVector(e.values as number[]),
          model: GEMINI_EMBEDDING_MODEL,
        }));
      }
    } catch (err) {
      console.warn('Gemini embedding API call failed; falling back to local lexical vectors:', err);
    }
  }

  return texts.map((t) => ({
    vector: computeLocalLexicalEmbedding(t),
    model: LOCAL_EMBEDDING_MODEL,
  }));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}
