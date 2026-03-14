export const SOURCE_LANGUAGES = ['French', 'German'] as const;
export const MODEL_OPTIONS = ['qwen3.5:0.8b', 'qwen3.5:2b', 'qwen3.5:4b', 'qwen/qwen3-vl-32b-instruct'] as const;

export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];
export type TargetLanguage = 'English';
export type ModelOption = (typeof MODEL_OPTIONS)[number];

export const MODEL_LABELS: Record<ModelOption, string> = {
  'qwen3.5:0.8b': 'Qwen 3.5 0.8B (local)',
  'qwen3.5:2b': 'Qwen 3.5 2B (local)',
  'qwen3.5:4b': 'Qwen 3.5 4B (local)',
  'qwen/qwen3-vl-32b-instruct': 'Qwen 3 VL 32B Instruct (paid)'
};

export const IMAGE_CAPABLE_MODELS: ReadonlyArray<ModelOption> = ['qwen3.5:0.8b', 'qwen3.5:2b', 'qwen3.5:4b', 'qwen/qwen3-vl-32b-instruct'];

export type TranslationBlockType = 'h1' | 'h2' | 'h3' | 'p' | 'formula' | 'image';

export interface TranslationBlock {
  id: string;
  type: TranslationBlockType;
  bbox: [number, number, number, number];
  html: string;
  text: string;
}

export interface ParsedTranslationPage {
  width: number;
  height: number;
  blocks: TranslationBlock[];
}

export interface TranslationResult {
  rawOutput: string;
  page: ParsedTranslationPage;
  meta: {
    model: string;
    sourceLanguage: SourceLanguage;
    targetLanguage: TargetLanguage;
    durationMs: number;
    usedFixture: boolean;
    prompts: {
      system: string;
      user: string;
    };
  };
}

export interface TranslatePageRequest {
  documentId: string;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  pageNumber: number;
  imageBase64?: string;
  mimeType?: string;
  model?: ModelOption;
  userPrompt?: string;
  debugUseFixture?: boolean;
}
