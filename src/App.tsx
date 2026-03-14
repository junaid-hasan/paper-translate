import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import renderMathInElement from 'katex/contrib/auto-render';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { translatePage } from './api';
import {
  MODEL_LABELS,
  MODEL_OPTIONS,
  SOURCE_LANGUAGES,
  type ModelOption,
  type SourceLanguage,
  type TranslationBlock,
  type TranslationResult
} from '../shared/types';

type ViewMode = 'single' | 'split';
type TranslationState = 'idle' | 'loading' | 'ready' | 'stale' | 'error';
type SelectedAssetKind = 'none' | 'image' | 'pdf';
type LanguageVerdict = 'Looks English' | 'Looks French' | 'Looks German' | 'Unclear';

const SAMPLE_MESSAGE = 'Upload a PDF or page image, or use a fixture. Press t to translate the current page.';
const MODEL_RASTER_SIZE = 1000;
const PDF_RENDER_SCALE = 2.2;

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unable to read file data'));
        return;
      }
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

function canvasToBase64Png(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

function detectContentBounds(canvas: HTMLCanvasElement): { x: number; y: number; width: number; height: number } {
  const context = canvas.getContext('2d');
  if (!context) {
    return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  }

  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset] ?? 255;
      const g = data[offset + 1] ?? 255;
      const b = data[offset + 2] ?? 255;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      if (luminance < 245) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width, height };
  }

  const padding = 12;
  return {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    width: Math.min(width, maxX - minX + 1 + padding * 2),
    height: Math.min(height, maxY - minY + 1 + padding * 2)
  };
}

function normalizeCanvasToSquarePng(sourceCanvas: HTMLCanvasElement, targetSize: number): string {
  const bounds = detectContentBounds(sourceCanvas);
  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create raster canvas');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, targetSize, targetSize);

  const scale = Math.min(targetSize / bounds.width, targetSize / bounds.height);
  const drawWidth = bounds.width * scale;
  const drawHeight = bounds.height * scale;
  const offsetX = (targetSize - drawWidth) / 2;
  const offsetY = (targetSize - drawHeight) / 2;

  context.drawImage(
    sourceCanvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    offsetX,
    offsetY,
    drawWidth,
    drawHeight
  );

  return canvasToBase64Png(canvas);
}

async function imageFileToSquareBase64(file: File, targetSize: number): Promise<string> {
  const url = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Failed to decode image file'));
      element.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to create raster canvas');
    }

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    return normalizeCanvasToSquarePng(canvas, targetSize);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function estimateBlockHeight(block: TranslationBlock): number {
  const baseHeightByType: Record<TranslationBlock['type'], number> = {
    h1: 64,
    h2: 52,
    h3: 42,
    p: 34,
    formula: 56,
    image: 120
  };

  const textLength = (block.text || block.html).replace(/<[^>]+>/g, '').length;
  const width = Math.max(120, block.bbox[2] - block.bbox[0]);
  const charsPerLine = Math.max(12, Math.floor(width / 14));
  const lineCount = Math.max(1, Math.ceil(textLength / charsPerLine));

  if (block.type === 'formula') {
    return Math.max(block.bbox[3] - block.bbox[1], baseHeightByType.formula + Math.max(0, lineCount - 1) * 18);
  }

  if (block.type === 'image') {
    return Math.max(block.bbox[3] - block.bbox[1], baseHeightByType.image);
  }

  const lineHeight = block.type.startsWith('h') ? 22 : 18;
  return Math.max(block.bbox[3] - block.bbox[1], baseHeightByType[block.type] + Math.max(0, lineCount - 1) * lineHeight);
}

function buildResolvedLayout(blocks: TranslationBlock[], pageHeight: number) {
  const sortedBlocks = [...blocks].sort((left, right) => {
    if (left.bbox[1] !== right.bbox[1]) {
      return left.bbox[1] - right.bbox[1];
    }

    return left.bbox[0] - right.bbox[0];
  });

  let cursorBottom = 16;

  return sortedBlocks.map((block) => {
    const rawTop = block.bbox[1];
    const resolvedTop = Math.max(rawTop, cursorBottom);
    const resolvedHeight = estimateBlockHeight(block);
    const resolvedBottom = Math.min(pageHeight - 8, resolvedTop + resolvedHeight);
    cursorBottom = resolvedBottom + 4;

    return {
      ...block,
      resolvedTop,
      resolvedHeight: Math.max(24, resolvedBottom - resolvedTop),
      flowGap: Math.max(0, Math.min(18, rawTop - (cursorBottom - resolvedHeight - 4)))
    };
  });
}

function countPattern(text: string, patterns: RegExp[]): number {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

function detectLanguageVerdict(text: string): LanguageVerdict {
  const normalized = text.replace(/\$[^$]*\$/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const english = countPattern(normalized, [/\bthe\b/g, /\band\b/g, /\bwith\b/g, /\bfrom\b/g, /\bthat\b/g]);
  const french = countPattern(normalized, [/\ble\b/g, /\bla\b/g, /\bles\b/g, /\bdes\b/g, /\bune\b/g, /[éèàùç]/g]);
  const german = countPattern(normalized, [/\bund\b/g, /\bder\b/g, /\bdie\b/g, /\bdas\b/g, /\bmit\b/g, /[äöüß]/g]);
  const ranked = [
    { label: 'Looks English' as const, score: english },
    { label: 'Looks French' as const, score: french },
    { label: 'Looks German' as const, score: german }
  ].sort((a, b) => b.score - a.score);
  if (!ranked[0] || !ranked[1] || ranked[0].score < 2 || ranked[0].score - ranked[1].score < 2) {
    return 'Unclear';
  }
  return ranked[0].label;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable;
}

function MathHtml({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }

    ref.current.innerHTML = html;
    renderMathInElement(ref.current, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false }
      ],
      throwOnError: false,
      strict: 'ignore'
    });
  }, [html]);

  return <div ref={ref} className={className} />;
}

export function App() {
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>('French');
  const [selectedModel, setSelectedModel] = useState<ModelOption>('qwen/qwen3-vl-32b-instruct');
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [translationState, setTranslationState] = useState<TranslationState>('idle');
  const [translation, setTranslation] = useState<TranslationResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showRawOutput, setShowRawOutput] = useState(false);
  const [customUserPrompt, setCustomUserPrompt] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [useFixture, setUseFixture] = useState(true);
  const [documentId, setDocumentId] = useState('fixture-document');
  const [selectedAssetKind, setSelectedAssetKind] = useState<SelectedAssetKind>('none');
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNumber, setCurrentPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [isRenderingPage, setIsRenderingPage] = useState(false);
  const [debugEvents, setDebugEvents] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const pushDebugEvent = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugEvents((previous) => [`[${timestamp}] ${message}`, ...previous].slice(0, 12));
  }, []);

  const invalidateTranslation = useCallback(() => {
    setTranslation(null);
    setErrorMessage(null);
    setTranslationState((previous) => {
      if (previous === 'idle') {
        return previous;
      }

      return 'stale';
    });
  }, []);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) {
      return;
    }

    const activePdfDocument = pdfDocument;

    let cancelled = false;

    async function renderPage() {
      setIsRenderingPage(true);
      pushDebugEvent(`Rendering PDF page ${currentPageNumber}.`);

      try {
        const page = await activePdfDocument.getPage(currentPageNumber);
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
        const canvas = canvasRef.current;

        if (!canvas || cancelled) {
          return;
        }

        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Could not get canvas context for PDF rendering');
        }

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: context, viewport }).promise;
        pushDebugEvent(`Rendered PDF page ${currentPageNumber} to canvas ${Math.round(viewport.width)}x${Math.round(viewport.height)} at scale ${PDF_RENDER_SCALE}.`);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Failed to render PDF page');
          pushDebugEvent(`PDF render failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      } finally {
        if (!cancelled) {
          setIsRenderingPage(false);
        }
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
    };
  }, [currentPageNumber, pdfDocument, pushDebugEvent]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setUseFixture(false);
    setErrorMessage(null);
    setTranslation(null);
    setTranslationState('idle');
    setCurrentPageNumber(1);
    setPageCount(1);
    setPdfDocument(null);
    setSelectedAssetKind('none');

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    if (file) {
      setDocumentId(`${file.name}-${file.size}`);
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        pushDebugEvent(`Loading PDF ${file.name}.`);
        const arrayBuffer = await file.arrayBuffer();
        const loadedPdf = await getDocument({ data: arrayBuffer }).promise;
        setPdfDocument(loadedPdf);
        setPageCount(loadedPdf.numPages);
        setPreviewUrl(null);
        setSelectedAssetKind('pdf');
        pushDebugEvent(`Loaded PDF with ${loadedPdf.numPages} pages.`);
      } else {
        setPreviewUrl(URL.createObjectURL(file));
        setSelectedAssetKind('image');
        pushDebugEvent(`Loaded image ${file.name} (${file.type || 'unknown mime'}).`);
      }
    } else {
      setPreviewUrl(null);
      setDocumentId('fixture-document');
      setSelectedAssetKind('none');
    }
  };

  const getCurrentPageImageBase64 = useCallback(async () => {
    if (useFixture) {
      return undefined;
    }

    if (selectedAssetKind === 'image' && selectedFile) {
      pushDebugEvent(`Normalizing image file ${selectedFile.name} to ${MODEL_RASTER_SIZE}x${MODEL_RASTER_SIZE} PNG before backend request.`);
      return imageFileToSquareBase64(selectedFile, MODEL_RASTER_SIZE);
    }

    if (selectedAssetKind === 'pdf' && canvasRef.current) {
      pushDebugEvent(
        `Rasterized PDF page ${currentPageNumber} from ${canvasRef.current.width}x${canvasRef.current.height} canvas, cropped margins, then normalized to ${MODEL_RASTER_SIZE}x${MODEL_RASTER_SIZE} PNG.`
      );
      return normalizeCanvasToSquarePng(canvasRef.current, MODEL_RASTER_SIZE);
    }

    throw new Error('Choose a PDF or image file, or enable fixture mode first.');
  }, [currentPageNumber, pushDebugEvent, selectedAssetKind, selectedFile, useFixture]);

  const handleTranslate = useCallback(async () => {
    if (!useFixture && selectedAssetKind === 'none') {
      setErrorMessage('Choose a PDF or image file, or enable fixture mode first.');
      setViewMode('split');
      setTranslationState('error');
      return;
    }

    setViewMode('split');
    setTranslationState('loading');
    setErrorMessage(null);
    pushDebugEvent(
      useFixture
        ? `Starting fixture translation for ${sourceLanguage}, page ${currentPageNumber}.`
        : `Starting real translation for ${sourceLanguage}, page ${currentPageNumber}, asset ${selectedAssetKind}, model ${selectedModel}.`
    );

    try {
      const imageBase64 = await getCurrentPageImageBase64();
      const result = await translatePage({
        documentId,
        sourceLanguage,
        targetLanguage: 'English',
        pageNumber: currentPageNumber,
        imageBase64,
        mimeType: selectedAssetKind === 'pdf' ? 'image/png' : selectedFile?.type,
        model: selectedModel,
        userPrompt: customUserPrompt.trim() || undefined,
        debugUseFixture: useFixture
      });

      setTranslation(result);
      setTranslationState('ready');
      pushDebugEvent(`Translation complete in ${result.meta.durationMs} ms with ${result.page.blocks.length} blocks using ${result.meta.model}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Translation failed';
      setErrorMessage(message);
      setTranslationState('error');
      pushDebugEvent(`Translation failed: ${message}`);
    }
  }, [currentPageNumber, customUserPrompt, documentId, getCurrentPageImageBase64, pushDebugEvent, selectedAssetKind, selectedFile?.type, selectedModel, sourceLanguage, useFixture]);

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.key === 'Escape') {
        setViewMode('single');
        setTranslationState('idle');
        return;
      }

      if (event.key.toLowerCase() === 't' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        await handleTranslate();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTranslate]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const handlePageChange = async (nextPageNumber: number) => {
    if (!pdfDocument || nextPageNumber < 1 || nextPageNumber > pageCount) {
      return;
    }

    setCurrentPageNumber(nextPageNumber);
    invalidateTranslation();
  };

  const markStale = () => {
    if (translationState === 'ready') {
      invalidateTranslation();
    }
  };

  const rightPaneLabel = useMemo(() => {
    switch (translationState) {
      case 'loading':
        return 'Translating current page...';
      case 'ready':
        return 'Translation ready for current page.';
      case 'stale':
        return 'Translation stale. Press t to refresh this page.';
      case 'error':
        return 'Translation failed. Press t to try again.';
      default:
        return 'Press t to translate the current page.';
    }
  }, [translationState]);

  const resolvedTranslationBlocks = useMemo(() => {
    if (!translation) {
      return [];
    }

    return buildResolvedLayout(translation.page.blocks, translation.page.height);
  }, [translation]);

  const proseText = useMemo(() => {
    if (!translation) {
      return '';
    }

    return translation.page.blocks
      .filter((block) => block.type === 'h1' || block.type === 'h2' || block.type === 'h3' || block.type === 'p')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }, [translation]);

  const languageVerdict = useMemo(() => detectLanguageVerdict(proseText), [proseText]);

  const handleCopyRawOutput = useCallback(async () => {
    if (!translation) {
      return;
    }

    try {
      await navigator.clipboard.writeText(translation.rawOutput);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('failed');
      window.setTimeout(() => setCopyState('idle'), 1500);
    }
  }, [translation]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Paper Translate</h1>
          <p>{SAMPLE_MESSAGE}</p>
          <p className="debug-inline">
            Mode: {useFixture ? 'fixture' : 'real'} | Asset: {selectedAssetKind} | State: {translationState} | Model: {selectedModel}
          </p>
        </div>
        <div className="controls">
          <label>
            Source language
            <select value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value as SourceLanguage)}>
              {SOURCE_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value as ModelOption)}>
              {MODEL_OPTIONS.map((model) => (
                <option key={model} value={model}>
                  {MODEL_LABELS[model]}
                </option>
              ))}
            </select>
          </label>
          <label className="prompt-editor">
            User prompt
            <textarea
              value={customUserPrompt}
              onChange={(e) => setCustomUserPrompt(e.target.value)}
              placeholder="Optional override for the user prompt sent with the image."
              rows={4}
            />
          </label>
          <label>
            <span>Fixture mode</span>
            <input
              type="checkbox"
              checked={useFixture}
              onChange={(e) => {
                setUseFixture(e.target.checked);
                invalidateTranslation();
              }}
            />
          </label>
          <label className="file-picker">
            PDF or page image
            <input ref={fileInputRef} type="file" accept="image/*,.pdf,application/pdf" onChange={handleFileChange} />
          </label>
          <div className="page-controls" aria-label="Page controls">
            <button type="button" onClick={() => void handlePageChange(currentPageNumber - 1)} disabled={selectedAssetKind !== 'pdf' || currentPageNumber <= 1}>
              Previous Page
            </button>
            <span>
              Page {currentPageNumber} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => void handlePageChange(currentPageNumber + 1)}
              disabled={selectedAssetKind !== 'pdf' || currentPageNumber >= pageCount}
            >
              Next Page
            </button>
          </div>
          <button type="button" onClick={() => setViewMode(viewMode === 'single' ? 'split' : 'single')}>
            {viewMode === 'single' ? 'Open Split View' : 'Single View'}
          </button>
          <button type="button" onClick={() => void handleTranslate()}>
            Translate Current Page
          </button>
          <button type="button" onClick={() => { setViewMode('single'); setTranslationState('idle'); }}>
            Exit Split View
          </button>
        </div>
      </header>
      <main className={viewMode === 'single' ? 'viewer single' : 'viewer split'}>
        <section className="pane pane-original" onScroll={markStale}>
          <div className="pane-header">
            <strong>Original</strong>
            <span>
              Source: {sourceLanguage}
              {selectedAssetKind === 'pdf' ? ` - PDF page ${currentPageNumber}` : ''}
            </span>
          </div>
          <div className="page-placeholder original-preview">
            {selectedAssetKind === 'pdf' ? (
              <div className="pdf-stage">
                {isRenderingPage ? <p>Rendering PDF page...</p> : null}
                <canvas ref={canvasRef} aria-label="Current PDF page" />
              </div>
            ) : null}
            {selectedAssetKind === 'image' && previewUrl ? <img src={previewUrl} alt="Selected source page" /> : null}
            {selectedAssetKind === 'none' ? 'PDF.js canvas or uploaded page image goes here' : null}
          </div>
        </section>
        {viewMode === 'split' ? (
          <section className="pane pane-translation">
            <div className="pane-header">
              <strong>Translation</strong>
              <span>Target: English - page {currentPageNumber}</span>
            </div>
            <div className="page-placeholder translation-state">
              {translationState !== 'ready' && translationState !== 'stale' ? <p>{rightPaneLabel}</p> : null}
              {translationState === 'stale' ? <p>{rightPaneLabel}</p> : null}
              {translationState === 'error' && errorMessage ? <p>{errorMessage}</p> : null}
              {(translationState === 'ready' || translationState === 'stale') && translation ? (
                <>
                  <div className="translation-meta">
                    <span className={`verdict verdict-${languageVerdict.toLowerCase().replace(/\s+/g, '-')}`}>{languageVerdict}</span>
                    {showRawOutput ? (
                      <button type="button" className="copy-raw-button" onClick={() => void handleCopyRawOutput()}>
                        {copyState === 'copied' ? 'Copied raw' : copyState === 'failed' ? 'Copy failed' : 'Copy raw'}
                      </button>
                    ) : null}
                  </div>
                  <div className="translation-flow" aria-label="Translated page">
                    {resolvedTranslationBlocks.map((block) => (
                      <div
                        key={block.id}
                        className={`translation-flow-block translation-flow-block-${block.type}`}
                        style={{
                          marginLeft: `${Math.max(0, Math.min(22, (block.bbox[0] / translation.page.width) * 18))}%`,
                          width: `${Math.max(52, Math.min(100, ((block.bbox[2] - block.bbox[0]) / translation.page.width) * 100))}%`,
                          marginTop: `${block.flowGap}px`
                        }}
                      >
                        {block.type === 'formula' ? <MathHtml html={block.html} className="math-html" /> : null}
                        {block.type === 'image' ? <div className="image-block">Image</div> : null}
                        {block.type !== 'formula' && block.type !== 'image' ? (
                          <MathHtml html={block.html} className="math-html" />
                        ) : null}
                      </div>
                    ))}
                  </div>
                  {showRawOutput ? (
                    <details className="raw-preview" open>
                      <summary>Raw model output</summary>
                      <div className="prompt-preview">
                        <strong>System prompt</strong>
                        <pre>{translation.meta.prompts.system}</pre>
                        <strong>User prompt</strong>
                        <pre>{translation.meta.prompts.user}</pre>
                      </div>
                      <pre>{translation.rawOutput}</pre>
                    </details>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>
        ) : null}
      </main>
      <section className="debug-panel">
        <strong>Debug</strong>
        <div className="debug-grid">
          <span>Mode</span>
          <span>{useFixture ? 'fixture' : 'real'}</span>
          <span>Asset</span>
          <span>{selectedAssetKind}</span>
          <span>Document</span>
          <span>{documentId}</span>
          <span>Current page</span>
          <span>
            {currentPageNumber} / {pageCount}
          </span>
          <span>Selected model</span>
          <span>{selectedModel}</span>
          <span>Raw output</span>
          <span>
            <label>
              <input type="checkbox" checked={showRawOutput} onChange={(e) => setShowRawOutput(e.target.checked)} /> Show raw
            </label>
          </span>
          <span>Canvas ready</span>
          <span>{canvasRef.current ? 'yes' : 'no'}</span>
          <span>Last error</span>
          <span>{errorMessage ?? 'none'}</span>
        </div>
        <div className="debug-log">
          {debugEvents.map((event) => (
            <div key={event}>{event}</div>
          ))}
        </div>
      </section>
    </div>
  );
}
