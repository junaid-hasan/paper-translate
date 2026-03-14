import { readFile } from 'node:fs/promises';
import { classifyParagraphLanguage, type LocalCheckModel } from './ollama-utils.js';

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const filePath = getArg('--file');
  const inlineText = getArg('--text');
  const model = (getArg('--model') as LocalCheckModel | undefined) ?? 'qwen3.5:0.8b';
  const text = filePath ? await readFile(filePath, 'utf8') : inlineText;

  if (!text) {
    throw new Error('Provide --text "..." or --file path/to/file.txt');
  }

  const result = await classifyParagraphLanguage(text, model);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
