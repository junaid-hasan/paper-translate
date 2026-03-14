import path from 'node:path';
import {
  getPdfPageCount,
  renderPdfPageToPng,
  sampleDistinctPages,
  translateImageAndCheckLanguage,
  type LocalCheckModel
} from './ollama-utils.js';
import type { SourceLanguage } from '../shared/types.js';

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const pdfPath = getArg('--pdf');
  const sourceLanguage = getArg('--source') as SourceLanguage | undefined;
  const sampleCount = Number(getArg('--samples') ?? '10');
  const translateModel = (getArg('--translate-model') as LocalCheckModel | undefined) ?? 'qwen3.5:2b';
  const checkerModel = (getArg('--checker-model') as LocalCheckModel | undefined) ?? 'qwen3.5:0.8b';

  if (!pdfPath || !sourceLanguage) {
    throw new Error('Usage: npm run eval:pdf-language -- --pdf translation_samples/german_paper.pdf --source German [--samples 10]');
  }

  const absolutePdfPath = path.resolve(pdfPath);
  const pageCount = await getPdfPageCount(absolutePdfPath);
  const pages = sampleDistinctPages(pageCount, sampleCount);
  let englishCount = 0;

  console.log(`Evaluating ${absolutePdfPath}`);
  console.log(`Pages sampled: ${pages.join(', ')}`);
  console.log(`Translate model: ${translateModel}; checker model: ${checkerModel}`);

  for (const pageNumber of pages) {
    const { imagePath, cleanup } = await renderPdfPageToPng(absolutePdfPath, pageNumber);
    try {
      const result = await translateImageAndCheckLanguage(imagePath, sourceLanguage, translateModel, checkerModel);
      const passed = result.languageCheck.language === 'English';
      if (passed) {
        englishCount += 1;
      }

      console.log('');
      console.log(`Page ${pageNumber}: ${passed ? 'PASS' : 'FAIL'}`);
      console.log(`  Detected language: ${result.languageCheck.language}`);
      console.log(`  Confidence: ${result.languageCheck.confidence}`);
      console.log(`  Reason: ${result.languageCheck.reason}`);
      console.log(`  Extracted preview: ${result.extractedText.slice(0, 220).replace(/\s+/g, ' ')}`);
    } finally {
      await cleanup();
    }
  }

  console.log('');
  console.log(`English pages: ${englishCount}/${pages.length}`);
  console.log(`Pass rate: ${((englishCount / pages.length) * 100).toFixed(1)}%`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
