export type ReceiptItem = { id: string; name: string; price: number; quantity: number };

export function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function parsePrice(raw: string) {
  const normalized = raw.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

function normalizeReceiptText(text: string) {
  return text
    .replace(/[’`]/g, "'")
    .replace(/[|]/g, ' ')
    .replace(/[€¢]/g, '€')
    .replace(/\b(?:eur|euro|euros)\b/gi, '€')
    .replace(/[Oo](?=\d{2}\b)/g, '0')
    .replace(/(?<=\d)[oO]\b/g, '0')
    .replace(/[Ss](?=\d{2}\b)/g, '5')
    .replace(/\s+/g, ' ');
}

function sanitizeItemName(raw: string) {
  return raw
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\b\d{1,3}\s*[x×]\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isIgnoredLine(name: string) {
  return /(total|subtotal|sub total|tax|troco|change|iva|vat|mbway|visa|mastercard|cash|multibanco|card|payment|paid|balance|service charge|tip)/i.test(
    name,
  );
}

function extractAmount(line: string) {
  const match = line.match(/([€$]?\s*[-]?\d{1,4}(?:[.,]\d{2}))\s*$/);
  if (!match) return null;
  const value = parsePrice(match[1]);
  return Number.isNaN(value) ? null : { raw: match[1], value };
}

function extractQuantityPrefix(line: string) {
  const match = line.match(/^(\d+(?:[.,]\d+)?)\s*[x×]\s+(.+)$/i);
  if (!match) return null;
  const quantity = parsePrice(match[1]);
  if (Number.isNaN(quantity) || quantity <= 0) return null;
  return { quantity, rest: match[2].trim() };
}

export function parseReceipt(text: string): { items: ReceiptItem[]; total: number } {
  const rawLines = text
    .split('\n')
    .map((l) => normalizeReceiptText(l).trim())
    .filter(Boolean);
  const lines: string[] = [];

  // OCR often splits "item" and "12.99" into separate lines, so stitch those pairs.
  for (let i = 0; i < rawLines.length; i++) {
    const current = rawLines[i];
    const next = rawLines[i + 1];
    if (
      next &&
      /[A-Za-z]/.test(current) &&
      !extractAmount(current) &&
      /^[€$]?\s*\d{1,4}(?:[.,]\d{2})$/.test(next)
    ) {
      lines.push(`${current} ${next}`);
      i += 1;
      continue;
    }
    lines.push(current);
  }

  const items: ReceiptItem[] = [];
  let total = 0;

  for (const line of lines) {
    const totalMatch = line.match(
      /(?:^|\s)(grand total|total|tot(?:al)?\.?|amount due|montante|a pagar)\s*[:€$ ]*([0-9]+[.,][0-9]{2})/i,
    );
    if (totalMatch) {
      const maybeTotal = parsePrice(totalMatch[2]);
      if (!Number.isNaN(maybeTotal)) total = Math.max(total, maybeTotal);
      continue;
    }

    if (/(subtotal|sub total|tax|iva|vat|tip|service charge)/i.test(line)) {
      continue;
    }

    const amount = extractAmount(line);
    if (!amount || amount.value <= 0) continue;

    const withoutAmount = line.slice(0, line.lastIndexOf(amount.raw)).trim();
    const quantityLine = extractQuantityPrefix(withoutAmount);
    const quantity = quantityLine?.quantity ?? 1;
    const name = sanitizeItemName(quantityLine?.rest ?? withoutAmount.replace(/^\d+\s+/, ''));

    if (!name || isIgnoredLine(name)) continue;
    if (name.length < 2 || !/[A-Za-z]/.test(name)) continue;

    const unitPrice = quantity > 1.05 && amount.value / quantity >= 0.2 ? amount.value / quantity : amount.value;

    items.push({
      id: uid('item'),
      name,
      price: Number(unitPrice.toFixed(2)),
      quantity: Number(quantity.toFixed(2)),
    });
  }

  if (!total) total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items: items.slice(0, 60), total };
}
