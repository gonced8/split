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

  it('parses dollar receipt sample with subtotal tax total', () => {
    const input = `
      1 Tacos Del Mal Shrimp $14.98
      1 Especial Salad Chicken $12.50
      1 Fountain Beverage $1.99
      SUBTOTAL: $29.47
      TAX: $1.92
      TOTAL: $31.39
    `;
    const out = parseReceipt(input);
    expect(out.items.map((i) => i.name)).toEqual([
      'Tacos Del Mal Shrimp',
      'Especial Salad Chicken',
      'Fountain Beverage',
    ]);
    expect(out.items.map((i) => i.price)).toEqual([14.98, 12.5, 1.99]);
    expect(out.total).toBeCloseTo(31.39, 2);
  });

  it('stitches OCR lines where the amount was split onto the next line', () => {
    const input = `
      SPICY TUNA ROLL
      8.50
      MISO SOUP
      2.00
      TOTAL 10.50
    `;
    const out = parseReceipt(input);
    expect(out.items.map((i) => i.name)).toEqual(['SPICY TUNA ROLL', 'MISO SOUP']);
    expect(out.items.map((i) => i.price)).toEqual([8.5, 2]);
    expect(out.total).toBeCloseTo(10.5, 2);
  });

  it('converts quantity rows with line totals into per-unit prices', () => {
    const input = `
      2 x Soda 6,00
      3 x Taco 13,50
      TOTAL 19,50
    `;
    const out = parseReceipt(input);
    expect(out.items).toMatchObject([
      { name: 'Soda', quantity: 2, price: 3 },
      { name: 'Taco', quantity: 3, price: 4.5 },
    ]);
    expect(out.total).toBeCloseTo(19.5, 2);
  });
});
