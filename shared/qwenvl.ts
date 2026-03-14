import { JSDOM } from 'jsdom';
import { z } from 'zod';
import type { ParsedTranslationPage, TranslationBlock, TranslationBlockType } from './types';

const allowedHeadingTags = new Set(['H1', 'H2', 'H3']);

const bboxSchema = z.tuple([
  z.number().min(0).max(1000),
  z.number().min(0).max(1000),
  z.number().min(0).max(1000),
  z.number().min(0).max(1000)
]);

function clamp(value: number): number {
  return Math.max(0, Math.min(1000, Math.round(value)));
}

export function parseBbox(rawValue: string | null | undefined): [number, number, number, number] {
  if (!rawValue) {
    throw new Error('Missing data-bbox attribute');
  }

  const parts = rawValue
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));

  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid data-bbox value: ${rawValue}`);
  }

  const normalized = [
    clamp(parts[0]),
    clamp(parts[1]),
    clamp(parts[2]),
    clamp(parts[3])
  ] as const;

  if (normalized[0] >= normalized[2] || normalized[1] >= normalized[3]) {
    throw new Error(`Degenerate data-bbox value: ${rawValue}`);
  }

  return bboxSchema.parse(normalized);
}

function guessBlockHeight(type: TranslationBlockType): number {
  switch (type) {
    case 'h1':
      return 70;
    case 'h2':
      return 60;
    case 'h3':
      return 50;
    case 'formula':
      return 70;
    case 'image':
      return 120;
    default:
      return 95;
  }
}

function buildFallbackBbox(index: number, type: TranslationBlockType): [number, number, number, number] {
  const top = Math.min(920, 40 + index * 85);
  const height = guessBlockHeight(type);
  return [80, top, 920, Math.min(990, top + height)];
}

export function extractHtmlDocument(rawText: string): string {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const unfenced = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const start = unfenced.search(/<html[\s>]/i);
  const endMatch = unfenced.match(/<\/html>/i);

  if (start >= 0 && endMatch?.index !== undefined) {
    return unfenced.slice(start, endMatch.index + endMatch[0].length).trim();
  }

  return unfenced;
}

function getBlockType(element: Element): TranslationBlockType | null {
  if (allowedHeadingTags.has(element.tagName)) {
    return element.tagName.toLowerCase() as TranslationBlockType;
  }

  if (element.tagName === 'P') {
    return 'p';
  }

  if (element.tagName === 'DIV' && element.getAttribute('class') === 'formula') {
    return 'formula';
  }

  if (element.tagName === 'DIV' && element.getAttribute('class') === 'image') {
    return 'image';
  }

  return null;
}

function sanitizeInnerHtml(element: Element, type: TranslationBlockType): string {
  if (type === 'image') {
    return '';
  }

  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('img').forEach((img) => img.remove());

  if (type === 'formula') {
    const nestedText = clone.textContent?.trim() ?? '';
    return nestedText;
  }

  return clone.innerHTML.trim();
}

function blockToText(html: string): string {
  if (!html) {
    return '';
  }

  const dom = new JSDOM(`<body>${html}</body>`);
  return dom.window.document.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

export function parseQwenVlHtml(rawHtml: string): ParsedTranslationPage {
  const trimmed = extractHtmlDocument(rawHtml);

  if (!trimmed.startsWith('<html')) {
    throw new Error('Expected HTML document starting with <html>');
  }

  const dom = new JSDOM(trimmed);
  const { document } = dom.window;
  const body = document.querySelector('body');

  if (!body) {
    throw new Error('Expected <body> in model response');
  }

  const blocks: TranslationBlock[] = [];

  Array.from(body.children as HTMLCollectionOf<Element>).forEach((element, index) => {
    const type = getBlockType(element);
    if (!type) {
      return;
    }

    let bbox: [number, number, number, number];
    try {
      bbox = parseBbox(element.getAttribute('data-bbox'));
    } catch {
      bbox = buildFallbackBbox(blocks.length, type);
    }

    const html = sanitizeInnerHtml(element, type);
    const text = type === 'formula' ? html : blockToText(html);

    blocks.push({
      id: `${type}-${index}`,
      type,
      bbox,
      html,
      text
    });
  });

  if (blocks.length === 0) {
    throw new Error('No supported translation blocks found');
  }

  return {
    width: 1000,
    height: 1000,
    blocks
  };
}
