# Translation Language Checks

## Check the language of one paragraph

```bash
npm run check:language -- --text "This is a short English paragraph."
```

Or from a file:

```bash
npm run check:language -- --file sample.txt
```

Default checker model: local Ollama `qwen3.5:0.8b`

## Evaluate random PDF pages

German paper:

```bash
npm run eval:pdf-language -- --pdf translation_samples/german_paper.pdf --source German --samples 10 --translate-model qwen3.5:2b --checker-model qwen3.5:0.8b
```

French paper:

```bash
npm run eval:pdf-language -- --pdf translation_samples/gaga_french.pdf --source French --samples 10 --translate-model qwen3.5:2b --checker-model qwen3.5:0.8b
```

The evaluator:

- samples distinct random pages
- renders each page to a PNG screenshot with `pdftoppm`
- sends the image to Ollama for translation
- extracts translated prose text from the returned `qwenvl html`
- asks a small model to classify the dominant language of that translated text
- reports per-page pass/fail and a final English pass rate

These helper scripts are optional and still assume local Ollama models for checking.

## Evaluate against a reference English PDF

When you have an approximate translated edition, compare translated source pages against it:

```bash
npm run eval:pdf-pair -- \
  --source-pdf translation_samples/gaga_french.pdf \
  --reference-pdf translation_samples/gaga_english.pdf \
  --source-language French \
  --samples 10 \
  --translate-model qwen3.5:2b \
  --checker-model qwen3.5:0.8b \
  --min-similarity 0.05
```

This paired evaluator checks two things:

- whether the translated page text is actually English
- whether that translated text has non-trivial token overlap with the best matching page in the reference English PDF

It is approximate, but it is much harder for untranslated German/French output to pass both checks.
