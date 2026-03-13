const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

interface Env {
  GEMINI_API_KEY: string;
  ALLOWED_ORIGIN: string;
}

function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }

    try {
      const { image, mimeType } = await request.json() as { image: string; mimeType: string };

      if (!image || !mimeType) {
        return new Response(JSON.stringify({ error: 'Missing image or mimeType' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      const geminiRes = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: SYSTEM_PROMPT },
              { inlineData: { mimeType, data: image } },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
      });

      if (!geminiRes.ok) {
        const err = await geminiRes.text();
        return new Response(JSON.stringify({ error: `Gemini error: ${err}` }), {
          status: geminiRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      const data: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } = await geminiRes.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(jsonStr);

      return new Response(JSON.stringify(parsed), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  },
};
