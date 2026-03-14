import type { TranslatePageRequest, TranslationResult } from '../shared/types';

export async function translatePage(request: TranslatePageRequest): Promise<TranslationResult> {
  const response = await fetch('/api/translate-page', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const json = await response.json().catch(() => null);
    const errorMessage = json?.error ?? `Translation failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return (await response.json()) as TranslationResult;
}
