import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseQwenVlHtml } from '../shared/qwenvl.js';
import type { SourceLanguage } from '../shared/types.js';

export type LocalCheckModel = 'qwen3.5:0.8b' | 'qwen3.5:2b' | 'qwen3.5:4b';

const execFileAsync = promisify(execFile);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/api/chat';

export interface LanguageCheckResult {
  language: 'English' | 'French' | 'German' | 'Other' | 'Mixed';
  confidence: number;
  reason: string;
}

export interface TranslationCheckResult {
  rawOutput: string;
  extractedText: string;
  languageCheck: LanguageCheckResult;
}

export interface ReferenceMatchResult {
  pageNumber: number;
  score: number;
  preview: string;
}

const LANGUAGE_MARKERS: Record<'English' | 'French' | 'German', RegExp[]> = {
  English: [
    /\bthe\b/gi,
    /\band\b/gi,
    /\bof\b/gi,
    /\bwith\b/gi,
    /\bthat\b/gi,
    /\bthis\b/gi,
    /\bfrom\b/gi,
    /\binto\b/gi
  ],
  French: [
    /\ble\b/gi,
    /\bla\b/gi,
    /\bles\b/gi,
    /\bdes\b/gi,
    /\bet\b/gi,
    /\bune\b/gi,
    /\bdu\b/gi,
    /\bque\b/gi,
    /[éèàùç]/g
  ],
  German: [
    /\bund\b/gi,
    /\bder\b/gi,
    /\bdie\b/gi,
    /\bdas\b/gi,
    /\beine\b/gi,
    /\bnach\b/gi,
    /\bvon\b/gi,
    /\bmit\b/gi,
    /[äöüß]/g
  ]
};

function cleanJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : trimmed;
}

async function chatWithOllama(messages: Array<Record<string, unknown>>, model: string, numPredict = 2048): Promise<string> {
  if (model.includes('/')) {
    throw new Error('Language-check scripts currently support Ollama models only');
  }
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: {
        temperature: 0.2,
        top_p: 0.8,
        top_k: 20,
        min_p: 0.0,
        repetition_penalty: 1.0,
        num_predict: numPredict
      },
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { message?: { content?: string }; error?: string };
  if (json.error) {
    throw new Error(`Ollama error: ${json.error}`);
  }

  const content = json.message?.content?.trim();
  if (!content) {
    throw new Error('Ollama returned empty content');
  }

  return content;
}

function countMatches(text: string, expressions: RegExp[]): number {
  return expressions.reduce((sum, expression) => sum + (text.match(expression)?.length ?? 0), 0);
}

function heuristicLanguageGuess(text: string): LanguageCheckResult | null {
  const normalized = text.replace(/\$[^$]*\$/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length < 80) {
    return null;
  }

  const english = countMatches(normalized, LANGUAGE_MARKERS.English);
  const french = countMatches(normalized, LANGUAGE_MARKERS.French);
  const german = countMatches(normalized, LANGUAGE_MARKERS.German);
  const ranked = [
    { language: 'English' as const, score: english },
    { language: 'French' as const, score: french },
    { language: 'German' as const, score: german }
  ].sort((left, right) => right.score - left.score);

  const best = ranked[0];
  const second = ranked[1];

  if (!best || !second || best.score < 3 || best.score - second.score < 2) {
    return null;
  }

  const confidence = Math.min(0.99, 0.55 + (best.score - second.score) * 0.06);
  return {
    language: best.language,
    confidence,
    reason: `Heuristic markers favored ${best.language.toLowerCase()} (${best.score} vs ${second.score}).`
  };
}

export async function classifyParagraphLanguage(text: string, model: LocalCheckModel = 'qwen3.5:0.8b'): Promise<LanguageCheckResult> {
  const heuristic = heuristicLanguageGuess(text);
  if (heuristic) {
    return heuristic;
  }

  const content = await chatWithOllama(
    [
      {
        role: 'system',
        content:
          'You classify the dominant language of a text excerpt. Ignore formulas and focus on surrounding prose. Respond with JSON only: {"language":"English|French|German|Other|Mixed","confidence":0.0-1.0,"reason":"short reason"}.'
      },
      {
        role: 'user',
        content: `Classify the dominant language of this text:\n\n${text}`
      }
    ],
    model,
    256
  );

  const parsed = JSON.parse(cleanJsonFence(content)) as Partial<LanguageCheckResult>;
  return {
    language: (parsed.language as LanguageCheckResult['language']) ?? 'Other',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : ''
  };
}

export async function translateImageAndCheckLanguage(imagePath: string, sourceLanguage: SourceLanguage, translateModel: LocalCheckModel, checkerModel: LocalCheckModel): Promise<TranslationCheckResult> {
  const imageBase64 = (await readFile(imagePath)).toString('base64');
  const rawOutput = await chatWithOllama(
    [
      {
        role: 'system',
        content: [
          'You are an expert mathematical translator and document layout extractor.',
          '',
          'Task:',
          'Given a scanned page image from a French or German mathematics paper, produce a structured translation in strict qwenvl HTML.',
          '',
          'Rules:',
          '1. Output ONLY valid HTML beginning with <html><body> and ending with </body></html>.',
          '2. Use only these elements: <h1>, <h2>, <h3>, <p>, <div class="formula">, <div class="image">.',
          '3. Every element must include data-bbox="x1 y1 x2 y2".',
          '4. Bounding boxes must use page-relative coordinates scaled to 0-1000.',
          '5. Translate natural-language prose into formal academic English.',
          '6. Preserve all mathematical notation exactly. Do not translate symbols, variables, operators, or equations.',
          '7. Use $...$ for inline math and $$...$$ for display math.',
          '8. Keep reading order faithful to the page.',
          '9. Do not include explanations, markdown fences, comments, or extra text outside the HTML.'
        ].join('\n')
      },
      {
        role: 'user',
        content: `Source language: ${sourceLanguage}\nTarget language: English\n\nTranslate the page into English and reconstruct the page structure in strict qwenvl HTML. Preserve mathematics exactly.`,
        images: [imageBase64]
      }
    ],
    translateModel,
    4096
  );

  const page = parseQwenVlHtml(rawOutput);
  const extractedText = page.blocks
    .filter((block) => block.type === 'p' || block.type === 'h1' || block.type === 'h2' || block.type === 'h3')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const languageCheck = await classifyParagraphLanguage(extractedText.slice(0, 2500), checkerModel);
  return {
    rawOutput,
    extractedText,
    languageCheck
  };
}

export async function getPdfPageCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileAsync('pdfinfo', [pdfPath]);
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) {
    throw new Error(`Could not determine page count for ${pdfPath}`);
  }
  return Number(match[1]);
}

export async function extractPdfPageText(pdfPath: string, pageNumber: number): Promise<string> {
  const { stdout } = await execFileAsync('pdftotext', ['-f', String(pageNumber), '-l', String(pageNumber), pdfPath, '-']);
  return stdout.replace(/\s+/g, ' ').trim();
}

export async function extractAllPdfPageText(pdfPath: string): Promise<Array<{ pageNumber: number; text: string }>> {
  const pageCount = await getPdfPageCount(pdfPath);
  const pages: Array<{ pageNumber: number; text: string }> = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    pages.push({
      pageNumber,
      text: await extractPdfPageText(pdfPath, pageNumber)
    });
  }
  return pages;
}

function tokenizeForSimilarity(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4);
}

export function findBestReferencePage(translatedText: string, referencePages: Array<{ pageNumber: number; text: string }>): ReferenceMatchResult | null {
  const translatedTokens = new Set(tokenizeForSimilarity(translatedText));
  if (translatedTokens.size === 0) {
    return null;
  }

  let best: ReferenceMatchResult | null = null;

  for (const page of referencePages) {
    const pageTokens = new Set(tokenizeForSimilarity(page.text));
    if (pageTokens.size === 0) {
      continue;
    }

    let intersection = 0;
    for (const token of translatedTokens) {
      if (pageTokens.has(token)) {
        intersection += 1;
      }
    }

    const union = new Set([...translatedTokens, ...pageTokens]).size;
    const score = union === 0 ? 0 : intersection / union;
    if (!best || score > best.score) {
      best = {
        pageNumber: page.pageNumber,
        score,
        preview: page.text.slice(0, 220)
      };
    }
  }

  return best;
}

export async function renderPdfPageToPng(pdfPath: string, pageNumber: number): Promise<{ imagePath: string; cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'rosetta-paper-eval-'));
  const outPrefix = path.join(tempDir, `page-${pageNumber}`);
  await execFileAsync('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-singlefile', '-png', pdfPath, outPrefix]);
  const imagePath = `${outPrefix}.png`;
  return {
    imagePath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

export function sampleDistinctPages(pageCount: number, sampleCount: number): number[] {
  const chosen = new Set<number>();
  while (chosen.size < Math.min(pageCount, sampleCount)) {
    chosen.add(1 + Math.floor(Math.random() * pageCount));
  }
  return [...chosen].sort((a, b) => a - b);
}
