import type { ReceiptItem } from './receipt';

export type Person = { id: string; name: string };

export function computeSplitTotals(
  people: Person[],
  items: ReceiptItem[],
  allocations: Record<string, Record<string, number>>,
  tipAmount: number,
) {
  const result: Record<string, number> = {};
  people.forEach((p) => (result[p.id] = 0));

  for (const item of items) {
    const totalAssigned = people.reduce((s, p) => s + (allocations[item.id]?.[p.id] || 0), 0);
    if (!totalAssigned) continue;
    for (const p of people) {
      const q = allocations[item.id]?.[p.id] || 0;
      result[p.id] += (q / totalAssigned) * item.price * item.quantity;
    }
  }

  const subtotalAllocated = Object.values(result).reduce((a, b) => a + b, 0);
  if (subtotalAllocated > 0 && tipAmount > 0) {
    for (const p of people) {
      const share = result[p.id] / subtotalAllocated;
      result[p.id] += tipAmount * share;
    }
  }

  return result;
}
