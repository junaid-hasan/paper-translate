import cors from 'cors';
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadFixtureTranslation } from './fixtures.js';
import { parseQwenVlHtml } from '../shared/qwenvl.js';
import { IMAGE_CAPABLE_MODELS } from '../shared/types.js';
import type { TranslatePageRequest, TranslationResult } from '../shared/types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const DEFAULT_MODEL = (process.env.OLLAMA_MODEL ?? 'qwen3.5:2b') as NonNullable<TranslatePageRequest['model']>;
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/api/chat';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const requestSchema = z.object({
  documentId: z.string().min(1),
  sourceLanguage: z.enum(['French', 'German']),
  targetLanguage: z.literal('English'),
  pageNumber: z.number().int().positive(),
  imageBase64: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  model: z.enum(['qwen3.5:0.8b', 'qwen3.5:2b', 'qwen3.5:4b', 'qwen/qwen3-vl-32b-instruct']).optional(),
  debugUseFixture: z.boolean().optional()
});

async function readProviderKey(provider: string): Promise<string> {
  const apiFilePath = path.join(process.cwd(), 'api.txt');
  const contents = await readFile(apiFilePath, 'utf8');
  const pattern = new RegExp(`"${provider}"\\s*=\\s*"([^"]+)"`);
  const match = contents.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Missing API key for provider '${provider}' in api.txt`);
  }
  return match[1];
}

function supportsImages(model: string | undefined): boolean {
  return Boolean(model && IMAGE_CAPABLE_MODELS.includes(model as (typeof IMAGE_CAPABLE_MODELS)[number]));
}

function isOpenRouterModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.includes('/');
}

function buildSystemPrompt(): string {
  return [
    'You are an expert mathematical translator and document layout extractor.',
    'Your target output language for all natural-language prose is English.',
    '',
    'Task:',
    'Given a scanned page image from a French or German mathematics paper, translate the natural-language content into English and produce the result in strict qwenvl HTML.',
    '',
    'Rules:',
    '1. Output ONLY valid HTML beginning with <html><body> and ending with </body></html>.',
    '2. Use only these elements: <h1>, <h2>, <h3>, <p>, <div class="formula">, <div class="image">.',
    '3. Every element must include data-bbox="x1 y1 x2 y2".',
    '4. Bounding boxes must use page-relative coordinates scaled to 0-1000.',
    '5. Translate every natural-language sentence, title, heading, caption, and paragraph into formal academic English.',
    '6. Preserve all mathematical notation exactly. Do not translate symbols, variables, operators, or equations.',
    '7. Use $...$ for inline math and $$...$$ for display math.',
    '8. Keep reading order faithful to the page.',
    '9. For figures or diagrams, use <div class="image"> with the bounding box and no descriptive hallucinations unless a visible caption exists.',
    '10. Do not include explanations, markdown fences, comments, or extra text outside the HTML.',
    '11. If any French or German prose remains untranslated in the output, the response is invalid.',
    '12. Never output the entire page as a single <div class="image"> when readable text is present.',
    '13. Do not use any tags or classes other than <h1>, <h2>, <h3>, <p>, <div class="formula">, and <div class="image">.',
    '14. Do not nest formula or image blocks recursively.',
    '15. For text-heavy pages, prefer multiple translated text blocks over image placeholders.',
    '16. Headings, captions, titles, and running headers must also be translated into English unless they are proper names only.'
  ].join('\n');
}

function buildUserPrompt(request: TranslatePageRequest): string {
  if (request.userPrompt?.trim()) {
    return request.userPrompt.trim();
  }

  return [
    `Source language: ${request.sourceLanguage}`,
    `Target language: ${request.targetLanguage}`,
    '',
    'Translate every natural-language part of the page into English and reconstruct the page structure in strict qwenvl HTML.',
    'Do not merely transcribe the source language.',
    'Do not leave French or German prose unchanged except for proper names, citations, and mathematical notation.',
    'Preserve mathematics exactly.'
  ].join('\n');
}

async function callOllama(request: TranslatePageRequest): Promise<string> {
  if (!request.imageBase64) {
    throw new Error('imageBase64 is required unless debugUseFixture is enabled');
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(request);

  let response: Response;
  try {
    response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: request.model ?? DEFAULT_MODEL,
        stream: false,
        think: false,
        options: {
          temperature: 0.7,
          top_p: 0.8,
          top_k: 20,
          min_p: 0.0,
          presence_penalty: 0.0,
          frequency_penalty: 0.0,
          repetition_penalty: 1.0,
          num_predict: 8192
        },
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt,
            images: [request.imageBase64]
          }
        ]
      })
    });
  } catch (error) {
    throw new Error(`Failed to reach Ollama at ${OLLAMA_URL}. Is Ollama running and serving the selected model? ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${errorText}`);
  }

  const json = (await response.json()) as { message?: { content?: string }; error?: string };

  if (json.error) {
    throw new Error(`Ollama error: ${json.error}`);
  }

  const content = json.message?.content?.trim();

  if (!content) {
    throw new Error(`Ollama returned an empty response: ${JSON.stringify(json).slice(0, 500)}`);
  }

  return content;
}

async function callOpenRouter(request: TranslatePageRequest): Promise<string> {
  if (!request.imageBase64) {
    throw new Error('imageBase64 is required unless debugUseFixture is enabled');
  }

  if (!supportsImages(request.model)) {
    throw new Error(`Selected model '${request.model}' does not support image input on OpenRouter`);
  }

  const apiKey = await readProviderKey('openrouter');
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(request);
  const model = request.model;

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:5173',
      'X-OpenRouter-Title': 'Rosetta Paper'
    },
    body: JSON.stringify({
      model,
      reasoning: { enabled: false },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${request.mimeType ?? 'image/png'};base64,${request.imageBase64}`
              }
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (json.error?.message) {
    throw new Error(`OpenRouter error: ${json.error.message}`);
  }

  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('OpenRouter returned empty content');
  }

  return content;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: DEFAULT_MODEL, targetLanguage: 'English' });
});

app.post('/api/translate-page', async (req, res) => {
  const parsedRequest = requestSchema.safeParse(req.body);

  if (!parsedRequest.success) {
    res.status(400).json({ error: 'Invalid translation request', details: parsedRequest.error.flatten() });
    return;
  }

  const request = parsedRequest.data;
  const startedAt = Date.now();

  try {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(request);
    const rawOutput = request.debugUseFixture
      ? await loadFixtureTranslation(request.sourceLanguage)
      : isOpenRouterModel(request.model)
        ? await callOpenRouter(request)
        : await callOllama(request);

    const page = parseQwenVlHtml(rawOutput);
    const result: TranslationResult = {
      rawOutput,
      page,
      meta: {
        model: request.model ?? DEFAULT_MODEL,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        durationMs: Date.now() - startedAt,
        usedFixture: Boolean(request.debugUseFixture),
        prompts: {
          system: systemPrompt,
          user: userPrompt
        }
      }
    };

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown translation error';
    res.status(500).json({ error: message });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Rosetta Paper server listening on ${port}`);
});
