import type { ReceiptItem } from './receipt';
import { uid } from './receipt';

const PROXY_URL = import.meta.env.VITE_PROXY_URL as string | undefined;

type GeminiResponse = {
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  currency: string;
};

export async function parseReceiptWithGemini(
  imageDataUrl: string,
): Promise<{ items: ReceiptItem[]; total: number; currency: string }> {
  const url = PROXY_URL;
  if (!url) {
    throw new Error('Extraction service not configured. Set VITE_PROXY_URL.');
  }

  const base64 = imageDataUrl.split(',')[1];
  const mimeType = imageDataUrl.match(/data:([^;]+)/)?.[1] ?? 'image/png';

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64, mimeType }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new Error('Rate limit reached. Wait a moment and try again.');
    }
    throw new Error(`Extraction failed (${response.status}): ${body || 'Unknown error'}`);
  }

  const data: GeminiResponse = await response.json();

  if (!Array.isArray(data.items)) {
    throw new Error('Unexpected response from extraction service.');
  }

  const items: ReceiptItem[] = data.items
    .filter((item) => item.name && typeof item.price === 'number' && item.price > 0)
    .map((item) => ({
      id: uid('item'),
      name: String(item.name).trim(),
      quantity: Math.max(1, Number(item.quantity) || 1),
      price: Number(item.price.toFixed(2)),
    }));

  return {
    items,
    total: Number((data.total || 0).toFixed(2)),
    currency: data.currency || 'EUR',
  };
}
