import { describe, expect, it } from 'vitest';
import { computeSplitTotals } from './split';

describe('computeSplitTotals', () => {
  it('splits by allocation fractions and applies tip proportionally', () => {
    const people = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const items = [
      { id: 'i1', name: 'Burger', quantity: 2, price: 10 },
    ];
    const allocations = {
      i1: { a: 1, b: 1 },
    };

    const totals = computeSplitTotals(people, items, allocations, 4);
    expect(totals.a).toBeCloseTo(12, 2);
    expect(totals.b).toBeCloseTo(12, 2);
  });
});
