export type ReceiptItem = { id: string; name: string; price: number; quantity: number };

export function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function parsePrice(raw: string) {
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

export function parseReceipt(text: string): { items: ReceiptItem[]; total: number } {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const items: ReceiptItem[] = [];
  let total = 0;

  for (const line of lines) {
    const totalMatch = line.match(/(?:^|\s)(total|tot(?:al)?\.?|amount due|montante|a pagar)\s*[:€$ ]*([0-9]+[.,][0-9]{2})/i);
    if (totalMatch) {
      const maybeTotal = parsePrice(totalMatch[2]);
      if (!Number.isNaN(maybeTotal)) total = Math.max(total, maybeTotal);
    }

    const qtyLine = line.match(/^([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s+(.+?)\s+[$€]?\s*([0-9]+[.,][0-9]{2})$/i);
    if (qtyLine) {
      const quantity = parsePrice(qtyLine[1]);
      const name = qtyLine[2].trim();
      const price = parsePrice(qtyLine[3]);
      if (name && !Number.isNaN(quantity) && !Number.isNaN(price)) {
        items.push({ id: uid('item'), name, price, quantity });
      }
      continue;
    }

    const itemMatch = line.match(/^(.+?)\s+[$€]?\s*([0-9]+[.,][0-9]{2})$/);
    if (!itemMatch) continue;

    const name = itemMatch[1].replace(/^\d+\s+/, '').replace(/\s{2,}/g, ' ').trim();
    const price = parsePrice(itemMatch[2]);
    if (!name || Number.isNaN(price)) continue;
    if (/(total|subtotal|tax|troco|change|iva|vat|mbway|visa|mastercard)/i.test(name)) continue;

    items.push({ id: uid('item'), name, price, quantity: 1 });
  }

  if (!total) total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items: items.slice(0, 60), total };
}
