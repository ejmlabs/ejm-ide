export interface LineItem {
  unitPrice: number;
  quantity: number;
}

/** Calculate an order total in integer cents. */
export function calculateTotal(items: readonly LineItem[]): number {
  return items.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
}

/** Format the total for the order summary. */
export function orderSummary(items: readonly LineItem[]): string {
  const total = calculateTotal(items);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(total / 100);
}
