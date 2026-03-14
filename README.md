# Paper Translate

Paper Translate is a browser PDF viewer for scanned math papers. It shows the original page on the left and an English translation on the right, using either local Ollama models or `qwen/qwen3-vl-32b-instruct` via OpenRouter.

## Current setup

- Frontend: React + Vite + `pdf.js`
- Backend: local Express server
- Models:
  - local Ollama: `qwen3.5:0.8b`, `qwen3.5:2b`, `qwen3.5:4b`
  - hosted OpenRouter: `qwen/qwen3-vl-32b-instruct`
- Math rendering: KaTeX

## Requirements

- Node 20+
- npm
- Optional: an OpenRouter API key
- Optional: Ollama running locally

## Installation

```bash
npm install
```

If you want hosted OpenRouter inference, create `api.txt` in the project root with this exact format:

```txt
"openrouter"="YOUR_OPENROUTER_KEY"
```

`api.txt` is ignored by git.

You can also use an environment variable instead:

```bash
export OPENROUTER_API_KEY="YOUR_OPENROUTER_KEY"
```

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
- Choose a model:
  - local Ollama for private/local usage
  - `qwen/qwen3-vl-32b-instruct` for the strongest hosted result
- Press `t` or click `Translate Current Page`
- Press `Esc` to leave split view
- Enable `Show raw` to inspect the exact model output and prompts

## Notes

- Translation is page-based and manual
- The best hosted model currently configured is `qwen/qwen3-vl-32b-instruct`
- The right pane uses a readable flow layout based on model structure, not strict page reconstruction
- Formulas are rendered with KaTeX when possible
- A simple in-memory rate limiter protects public demos from light abuse

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

## Hugging Face Spaces

This project can be deployed to a Hugging Face Docker Space.

### Recommended approach

- Create a new Hugging Face Space
- Choose `Docker` as the SDK
- Add a Space secret:
  - `OPENROUTER_API_KEY`
- Push this repository to the Space

The included `Dockerfile` builds the frontend and backend together and serves the built app from the Express server on port `7860`.

### Why this works better than GitHub Pages

- the app needs a backend for translation requests
- the API key must stay server-side
- Docker Spaces support private secrets and server processes

### Budget safety

If your OpenRouter key has a small monthly cap, you should still be careful with public demos.

Current lightweight protections:

- in-memory request rate limit per client/IP
- manual page-by-page translation only

For a stricter public demo later, consider limiting uploads or serving only sample PDFs.
