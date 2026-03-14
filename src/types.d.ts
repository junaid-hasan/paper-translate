declare module 'katex/contrib/auto-render' {
  export default function renderMathInElement(
    element: HTMLElement,
    options?: {
      delimiters?: Array<{ left: string; right: string; display: boolean }>;
      throwOnError?: boolean;
      strict?: boolean | 'ignore' | 'warn' | 'error';
    }
  ): void;
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const workerUrl: string;
  export default workerUrl;
}
