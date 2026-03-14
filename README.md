# Rosetta Paper

Rosetta Paper is a browser PDF viewer for scanned math papers. It shows the original page on the left and an English translation on the right, using a vision model via OpenRouter.

## Current setup

- Frontend: React + Vite + `pdf.js`
- Backend: local Express server
- Model: `qwen/qwen3-vl-32b-instruct` via OpenRouter
- Math rendering: KaTeX

## Requirements

- Node 20+
- npm
- An OpenRouter API key

## Installation

```bash
npm install
```

Create `api.txt` in the project root with this exact format:

```txt
"openrouter"="YOUR_OPENROUTER_KEY"
```

`api.txt` is ignored by git.

## Run locally

Start the backend:

```bash
npm run dev:server
```

Start the frontend in another terminal:

```bash
npm run dev:web
```

Open:

```txt
http://localhost:5173
```

## Usage

- Upload a PDF or page image
- Choose the source language: French or German
- Press `t` or click `Translate Current Page`
- Press `Esc` to leave split view
- Enable `Show raw` to inspect the exact model output and prompts

## Notes

- Translation is page-based and manual
- The current public model choice is `qwen/qwen3-vl-32b-instruct`
- The right pane uses a readable flow layout based on model structure, not strict page reconstruction
- Formulas are rendered with KaTeX when possible

## Quality checks

Run tests:

```bash
npm test
```

Build everything:

```bash
npm run build
```

Language evaluation helpers are also available:

```bash
npm run check:language -- --text "This is English."
npm run eval:pdf-language -- --pdf translation_samples/german_paper.pdf --source German --samples 5
```

## GitHub

A CI workflow is included to run tests and builds on pushes and pull requests.

GitHub Pages is not configured here because live translation requires a backend and an API key. You can still host the frontend separately later if you point it at a hosted backend.
