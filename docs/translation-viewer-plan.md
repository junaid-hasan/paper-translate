# Paper Translate V0 Plan

## Product goal

Build a browser-based PDF viewer that shows the original page on the left and an on-demand English translation on the right.

## V0 decisions

- Translation is manual and page-based.
- `t` translates the current page.
- `Esc` exits split view.
- Scrolling or page changes make the translation stale until retriggered.
- Source language is selected once per document.
- Target language is English.
- The model is local `Qwen 3.5 4B` via Ollama.

## Pipeline

1. Render the current PDF page in the browser.
2. Export the current page to an image.
3. Send the image plus document metadata to a local backend.
4. Ask the model for strict `qwenvl html`.
5. Parse and sanitize the model output.
6. Convert parsed HTML to internal block JSON.
7. Render translated blocks in the right pane.

## Initial fixtures

- `translation_samples/french.png`
- `translation_samples/german.png`
- `translation_samples/german_paper.pdf`

## Initial tests

- Parser accepts valid `qwenvl html` and rejects malformed bbox data.
- Backend validates translation request shape.
- Frontend exposes document-level language selection.
- Frontend enters split mode for translation and returns to single mode on exit.
