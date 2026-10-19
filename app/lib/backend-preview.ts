import { previewGit } from './git-preview';
import type { Document, Entry, Workspace } from './types';

// Keep preview samples independent of editable workspace files and the native HMR graph.
const previewFiles: Record<string, string> = {
  'src/orders.rs': `use crate::money::{Money, calculate_total};
use crate::payments::charge;
use crate::{Error, Order, Receipt, Store};

/// Settle an order after a successful payment.
///
/// The order key also identifies the payment, so a retry is safe.
pub fn settle_order(order: &Order, store: &impl Store) -> Result<Receipt, Error> {
    if let Some(receipt) = store.find_receipt(&order.key)? {
        return Ok(receipt);
    }

    let total = calculate_total(&order.items);
    let receipt = charge(order, total)?;
    store.save_receipt(&receipt)?;
    Ok(receipt)
}

/// Preview the amount before collecting payment.
pub fn quote_order(order: &Order) -> Money {
    calculate_total(&order.items)
}
`,
  'src/money.rs': `pub type Money = i64;

#[derive(Clone, Debug)]
pub struct LineItem {
    pub unit_price: Money,
    pub quantity: u32,
    pub discount_percent: u8,
}

impl LineItem {
    /// The line amount in cents, before discounts.
    pub fn total(&self) -> Money {
        self.unit_price * i64::from(self.quantity)
    }
}

/// Sum line totals after discounts.
pub fn calculate_total(items: &[LineItem]) -> Money {
    items
        .iter()
        .map(|item| apply_discount(item.total(), item.discount_percent))
        .sum()
}

/// Apply a percentage discount using integer cents.
pub fn apply_discount(amount: Money, percent: u8) -> Money {
    amount * i64::from(100 - percent.min(100)) / 100
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_include_quantity_and_discount() {
        let items = [LineItem { unit_price: 1200, quantity: 2, discount_percent: 10 }];
        assert_eq!(calculate_total(&items), 2160);
    }
}
`,
  'src/payments.rs': `use crate::money::Money;
use crate::{Error, Order, Receipt};

/// Sample payment adapter. A real provider should use \`order.key\`
/// as its idempotency key before charging.
pub fn charge(order: &Order, amount: Money) -> Result<Receipt, Error> {
    if amount < 0 {
        return Err(Error("The amount cannot be negative".into()));
    }
    Ok(Receipt { order_key: order.key.clone(), amount })
}
`,
  'src/lib.rs': `//! A small sample project for exploring Workbench.
pub mod money;
pub mod orders;
pub mod payments;

#[derive(Clone, Debug)]
pub struct Order {
    pub key: String,
    pub items: Vec<money::LineItem>,
}

#[derive(Clone, Debug)]
pub struct Receipt {
    pub order_key: String,
    pub amount: money::Money,
}

#[derive(Debug)]
pub struct Error(pub String);

pub trait Store {
    fn find_receipt(&self, key: &str) -> Result<Option<Receipt>, Error>;
    fn save_receipt(&self, receipt: &Receipt) -> Result<(), Error>;
}
`,
  'tools/reconcile.py': `"""Match payment receipts to the orders in a daily export."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Receipt:
    order_key: str
    amount: int


def total_received(receipts: list[Receipt]) -> int:
    """Return the total received, in integer cents."""
    return sum(receipt.amount for receipt in receipts)


def reconcile(expected: int, receipts: list[Receipt]) -> int:
    """Return the difference between expected and received funds."""
    return expected - total_received(receipts)
`,
  'web/orders.ts': `export interface LineItem {
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
`,
  'Cargo.toml': `[package]
name = "harbor"
version = "0.1.0"
edition = "2024"

[lib]
path = "src/lib.rs"
`,
  'README.md': `# Harbor

A sample workspace for ejm-ide. Explore \`calculate_total\` in Rust or Ruby,
\`total_received\` in Python, and \`calculateTotal\` in TypeScript or Go.

Use Go to Definition, Find References, or Call Hierarchy from the editor menu.
Select code and press Cmd+L to attach it to chat. These files are local and editable.

Ruby LSP provides definition and reference lookup. It does not provide semantic
call hierarchy. See [language setup](../../docs/languages.md) for the required
tools and Ruby formatter configuration.
`,
};
function previewEntries(path: string, previewRoot: string): Entry[] {
  const prefix = path.replace(`${previewRoot}/`, '').replace(previewRoot, '');
  const seen = new Map<string, Entry>();
  Object.keys(previewFiles).forEach((file) => {
    if (prefix && !file.startsWith(`${prefix}/`)) return;
    const rest = prefix ? file.slice(prefix.length + 1) : file;
    const [name, ...parts] = rest.split('/');
    if (name)
      seen.set(name, { path: `${path}/${name}`, name, kind: parts.length ? 'directory' : 'file' });
  });
  return [...seen.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}

export function invokePreview<T>(
  command: string,
  args: Record<string, unknown>,
  previewRoot: string,
): T {
  // Browser preview is explicitly read-only. Native services run in the desktop app.
  if (command.startsWith('git_')) return previewGit(command, args, previewRoot, previewFiles) as T;
  let value: unknown;
  switch (command) {
    case 'workspace_current':
    case 'workspace_open':
      value = {
        root: previewRoot,
        name: 'harbor',
        entries: previewEntries(previewRoot, previewRoot),
        branch: null,
      } satisfies Workspace;
      break;
    case 'workspace_entries':
      value = previewEntries(String(args.path), previewRoot);
      break;
    case 'workspace_read': {
      const file = String(args.path).replace(`${previewRoot}/`, '');
      if (!(file in previewFiles)) throw new Error('This file is not in the browser preview.');
      value = {
        path: String(args.path),
        content: previewFiles[file],
        version: 'preview',
      } satisfies Document;
      break;
    }
    case 'workspace_create':
      throw new Error('Open the desktop app to save a new file. Browser preview is read-only.');
    case 'workspace_search':
      value = Object.entries(previewFiles)
        .flatMap(([path, content]) =>
          content
            .split('\n')
            .flatMap((text, i) =>
              text.toLowerCase().includes(String(args.query).toLowerCase())
                ? [{ path: `${previewRoot}/${path}`, line: i + 1, text }]
                : [],
            ),
        )
        .slice(0, 150);
      break;
    case 'workspace_changes':
      value = [];
      break;
    case 'language_open':
      value = {
        language: 'Preview',
        status: 'unavailable',
        message: 'Open the desktop app for language intelligence.',
      };
      break;
    case 'language_change':
    case 'language_close':
      value = null;
      break;
    case 'extensions_list':
      value = [];
      break;
    default:
      throw new Error(`Open the desktop app to use ${command.replaceAll('_', ' ')}.`);
  }
  return value as T;
}
