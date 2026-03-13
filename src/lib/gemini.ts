import type { ReceiptItem } from './receipt';
import { uid } from './receipt';

const PROXY_URL = import.meta.env.VITE_PROXY_URL as string | undefined;
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `You are a receipt parser. Given an image of a receipt, extract all line items and the total.

Return ONLY valid JSON in this exact format (no markdown, no code fences):
{
  "items": [
    { "name": "Item name", "quantity": 1, "price": 12.99 }
  ],
  "total": 45.50,
  "currency": "EUR"
}

Rules:
- "price" is the unit price per item, NOT the line total. If the receipt shows "2x Beer 10.00", the price should be 5.00 and quantity 2.
- If no quantity is shown, assume 1.
- Do NOT include subtotal, tax, VAT, tip, service charge, or payment method lines as items.
- "total" should be the final total on the receipt (including tax). If multiple totals exist, use the largest.
- If you cannot read the receipt clearly, return {"items": [], "total": 0, "currency": "EUR"} and nothing else.
- Use the currency symbol shown on the receipt. Default to "EUR" if unclear.`;

type GeminiResponse = {
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  currency: string;
};

/** Parse error body from proxy ({ error }) or Gemini ({ error: { message } }) and return a user-facing message. */
function parseErrorMessage(body: string, status: number): string {
  const fallback429 = 'Rate limit or quota exceeded. Wait a moment or check your quota and try again.';
  try {
    const data = JSON.parse(body || '{}') as { error?: string | { message?: string } };
    const err = data?.error;
    if (typeof err === 'string' && err.trim()) return err;
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.trim())
      return err.message;
  } catch {
    /* use fallback */
  }
  if (status === 429) return fallback429;
  if (body && body.length < 200) return body;
  return '';
}

function parseGeminiResponse(data: GeminiResponse): { items: ReceiptItem[]; total: number; currency: string } {
  if (!Array.isArray(data.items)) {
    throw new Error('Unexpected response: missing items array.');
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

async function parseViaProxy(imageDataUrl: string): Promise<{ items: ReceiptItem[]; total: number; currency: string }> {
  const url = PROXY_URL;
  if (!url) {
    throw new Error('Extraction service not configured. Set VITE_PROXY_URL (or VITE_GEMINI_API_KEY for local dev).');
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
    const msg = parseErrorMessage(body, response.status);
    throw new Error(msg || `Extraction failed (${response.status}).`);
  }

  const data: GeminiResponse = await response.json();
  return parseGeminiResponse(data);
}

async function parseViaDirectApi(imageDataUrl: string): Promise<{ items: ReceiptItem[]; total: number; currency: string }> {
  const key = API_KEY;
  if (!key) {
    throw new Error('VITE_GEMINI_API_KEY is not set.');
  }

  const base64 = imageDataUrl.split(',')[1];
  const mimeType = imageDataUrl.match(/data:([^;]+)/)?.[1] ?? 'image/png';

  const response = await fetch(`${GEMINI_API_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: SYSTEM_PROMPT },
            { inlineData: { mimeType, data: base64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    if (response.status === 400 && err.includes('API_KEY')) {
      throw new Error('Invalid Gemini API key. Check VITE_GEMINI_API_KEY.');
    }
    const msg = parseErrorMessage(err, response.status);
    throw new Error(msg || `Gemini API error (${response.status}).`);
  }

  const json = await response.json();
  const text: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  let data: GeminiResponse;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error('Could not parse Gemini response as JSON.');
  }

  return parseGeminiResponse(data);
}

/** Use this to show in UI which mode is active (direct API key vs proxy). */
export function getGeminiMode(): 'direct' | 'proxy' {
  return API_KEY ? 'direct' : 'proxy';
}

export async function parseReceiptWithGemini(
  imageDataUrl: string,
): Promise<{ items: ReceiptItem[]; total: number; currency: string }> {
  if (API_KEY) {
    return parseViaDirectApi(imageDataUrl);
  }
  return parseViaProxy(imageDataUrl);
}
