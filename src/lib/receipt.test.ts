import { describe, expect, it } from 'vitest';
import { parseReceipt } from './receipt';

describe('parseReceipt', () => {
  it('parses quantity lines and total', () => {
    const input = `
      2 x Burger 12,90
      1 x Fries 3,50
      Total 16,40
    `;
    const out = parseReceipt(input);
    expect(out.items.length).toBe(2);
    expect(out.items[0].quantity).toBe(2);
    expect(out.total).toBeCloseTo(16.4, 2);
  });

  it('ignores non-item totals/subtotal rows', () => {
    const input = `
      Subtotal 10,00
      VAT 2,30
      Steak 12,30
    `;
    const out = parseReceipt(input);
    expect(out.items.map((i) => i.name)).toEqual(['Steak']);
  });
});
