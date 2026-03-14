import path from 'node:path';
import {
  extractAllPdfPageText,
  findBestReferencePage,
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
  const sourcePdf = getArg('--source-pdf');
  const referencePdf = getArg('--reference-pdf');
  const sourceLanguage = getArg('--source-language') as SourceLanguage | undefined;
  const sampleCount = Number(getArg('--samples') ?? '10');
  const translateModel = (getArg('--translate-model') as LocalCheckModel | undefined) ?? 'qwen3.5:2b';
  const checkerModel = (getArg('--checker-model') as LocalCheckModel | undefined) ?? 'qwen3.5:0.8b';
  const minSimilarity = Number(getArg('--min-similarity') ?? '0.05');

  if (!sourcePdf || !referencePdf || !sourceLanguage) {
    throw new Error('Usage: npm run eval:pdf-pair -- --source-pdf translation_samples/gaga_french.pdf --reference-pdf translation_samples/gaga_english.pdf --source-language French');
  }

  const sourcePath = path.resolve(sourcePdf);
  const referencePath = path.resolve(referencePdf);
  const pageCount = await getPdfPageCount(sourcePath);
  const pages = sampleDistinctPages(pageCount, sampleCount);
  const referencePages = await extractAllPdfPageText(referencePath);

  let englishCount = 0;
  let similarityPassCount = 0;

  console.log(`Source PDF: ${sourcePath}`);
  console.log(`Reference PDF: ${referencePath}`);
  console.log(`Pages sampled: ${pages.join(', ')}`);
  console.log(`Translate model: ${translateModel}; checker model: ${checkerModel}`);
  console.log(`Minimum similarity threshold: ${minSimilarity}`);

  for (const pageNumber of pages) {
    const { imagePath, cleanup } = await renderPdfPageToPng(sourcePath, pageNumber);
    try {
      const result = await translateImageAndCheckLanguage(imagePath, sourceLanguage, translateModel, checkerModel);
      const englishPass = result.languageCheck.language === 'English';
      if (englishPass) {
        englishCount += 1;
      }

      const bestMatch = findBestReferencePage(result.extractedText, referencePages);
      const similarityPass = (bestMatch?.score ?? 0) >= minSimilarity;
      if (similarityPass) {
        similarityPassCount += 1;
      }

      console.log('');
      console.log(`Source page ${pageNumber}: ${englishPass && similarityPass ? 'PASS' : 'FAIL'}`);
      console.log(`  English check: ${result.languageCheck.language} (${result.languageCheck.confidence})`);
      console.log(`  Language reason: ${result.languageCheck.reason}`);
      console.log(`  Best reference page: ${bestMatch?.pageNumber ?? 'none'}`);
      console.log(`  Similarity score: ${(bestMatch?.score ?? 0).toFixed(3)}`);
      console.log(`  Translation preview: ${result.extractedText.slice(0, 220).replace(/\s+/g, ' ')}`);
      console.log(`  Reference preview: ${bestMatch?.preview.replace(/\s+/g, ' ') ?? ''}`);
    } finally {
      await cleanup();
    }
  }

  console.log('');
  console.log(`English pass rate: ${englishCount}/${pages.length} (${((englishCount / pages.length) * 100).toFixed(1)}%)`);
  console.log(`Reference similarity pass rate: ${similarityPassCount}/${pages.length} (${((similarityPassCount / pages.length) * 100).toFixed(1)}%)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
