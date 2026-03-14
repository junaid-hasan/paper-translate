import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SourceLanguage } from '../shared/types.js';

const fixturePathByLanguage: Record<SourceLanguage, string> = {
  French: 'translation_samples/french_translation.txt',
  German: 'translation_samples/german_translation.txt'
};

export async function loadFixtureTranslation(sourceLanguage: SourceLanguage): Promise<string> {
  const relativePath = fixturePathByLanguage[sourceLanguage];
  const filePath = path.join(process.cwd(), relativePath);
  const contents = await readFile(filePath, 'utf8');
  return contents.replace(/^\d+:\s*/, '').trim();
}
