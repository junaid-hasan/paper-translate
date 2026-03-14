import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractHtmlDocument, parseBbox, parseQwenVlHtml } from '../shared/qwenvl';

function loadFixture(name: 'french' | 'german'): string {
  const raw = readFileSync(`./translation_samples/${name}_translation.txt`, 'utf8');
  return raw.replace(/^\d+:\s*/, '').trim();
}

describe('parseBbox', () => {
  it('parses bbox coordinates', () => {
    expect(parseBbox('10 20 300 400')).toEqual([10, 20, 300, 400]);
  });

  it('rejects invalid bbox values', () => {
    expect(() => parseBbox('10 20 30')).toThrow();
  });
});

describe('parseQwenVlHtml', () => {
  it('strips markdown fences around html output', () => {
    const raw = '```html\n<html><body><p data-bbox="0 0 100 100">hello</p></body></html>\n```';
    expect(extractHtmlDocument(raw)).toBe('<html><body><p data-bbox="0 0 100 100">hello</p></body></html>');
  });

  it('falls back when bbox attributes are missing', () => {
    const page = parseQwenVlHtml('<html><body><h2>Title</h2><p>Body</p></body></html>');
    expect(page.blocks).toHaveLength(2);
    expect(page.blocks[0]?.bbox).toEqual([80, 40, 920, 100]);
  });

  it('parses the German translation fixture into blocks', () => {
    const page = parseQwenVlHtml(loadFixture('german'));
    expect(page.blocks.length).toBeGreaterThan(5);
    expect(page.blocks.some((block) => block.type === 'formula')).toBe(true);
  });

  it('parses the French translation fixture into blocks', () => {
    const page = parseQwenVlHtml(loadFixture('french'));
    expect(page.blocks.some((block) => block.type === 'h1')).toBe(true);
    expect(page.blocks.some((block) => block.type === 'p')).toBe(true);
  });
});
