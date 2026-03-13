// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import Tesseract from 'tesseract.js';
import { parseReceipt } from './receipt';

describe('receipt OCR fixture', () => {
  it(
    'extracts line items and total from sample receipt image',
    async () => {
      const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/receipt-sample.jpg');
      const result = await Tesseract.recognize(fixturePath, 'eng');
      const parsed = parseReceipt(result.data.text);

      const names = parsed.items.map((i) => i.name.toLowerCase());

      expect(names.some((n) => n.includes('tacos') && n.includes('shrimp'))).toBe(true);
      expect(names.some((n) => n.includes('salad') && n.includes('chicken'))).toBe(true);
      expect(names.some((n) => n.includes('fountain') && n.includes('beverage'))).toBe(true);
      expect(parsed.total).toBeCloseTo(31.39, 1);
    },
    120000,
  );
});
