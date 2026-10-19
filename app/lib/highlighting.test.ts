import type { HighlighterCore } from 'shiki/core';
import { beforeAll, expect, it } from 'vitest';
import { editorTheme, monacoThemeNames } from './editor-theme';
import { createSyntaxHighlighter } from './highlighting';

let highlighter: HighlighterCore;
beforeAll(async () => {
  highlighter = await createSyntaxHighlighter();
});

it.each([
  ['rust', 'pub struct Invoice { amount: i32 }\nfn total(amount: i32) -> i32 { amount }'],
  ['python', 'class Invoice:\n    def total(self, amount: int):\n        return amount'],
  ['ruby', 'class Invoice\n  def total(amount)\n    amount\n  end\nend'],
  ['go', 'package main\nfunc total(amount int) int { return amount }'],
  [
    'typescript',
    'interface Invoice { amount: number }\nfunction total(amount: number) { return amount; }',
  ],
  ['javascript', 'function total(amount) { return amount; }'],
  ['tsx', 'const Total = () => <div className="total">{3}</div>;'],
  ['jsx', 'const Total = () => <div className="total">{3}</div>;'],
  ['json', '{"amount": 3, "paid": true}'],
  ['jsonc', '// amount\n{"amount": 3,}'],
  ['toml', '[package]\nname = "workbench"\nversion = 3'],
  ['ini', '[main]\nname=workbench'],
  ['yaml', 'name: workbench\nversion: 3'],
  ['html', '<div class="total">Invoice</div>'],
  ['css', '.total { color: #729df3; }'],
  ['scss', '$accent: #729df3;\n.total { color: $accent; }'],
  ['less', '@accent: #729df3;\n.total { color: @accent; }'],
  ['sql', 'SELECT amount FROM invoices WHERE paid = true;'],
  ['shell', '#!/bin/sh\necho "Invoice $AMOUNT"'],
  ['xml', '<invoice amount="3">paid</invoice>'],
  ['dockerfile', 'FROM rust:latest\nWORKDIR /app'],
  ['graphql', 'query Invoice { invoice { amount } }'],
  ['markdown', '# Invoice\n\n**Paid** with `amount`'],
])('tokenizes %s through its bundled TextMate grammar without black text', (lang, source) => {
  const tokens = highlighter
    .codeToTokens(source, { lang, theme: monacoThemeNames.dark })
    .tokens.flat();
  const colors = tokens
    .filter((token) => token.content.trim())
    .map((token) => token.color?.toUpperCase());
  expect(colors.length).toBeGreaterThan(0);
  expect(colors).not.toContain('#000000');
  expect(new Set(colors).size).toBeGreaterThan(1);
});

it.each([
  ['python', 'class Invoice:\n    def total(self, amount: int):\n        return amount'],
  ['ruby', 'class Invoice\n  def total(amount)\n    amount\n  end\nend'],
])(
  'distinguishes %s class and method declarations without semantic token support',
  (lang, source) => {
    const tokens = highlighter
      .codeToTokens(source, { lang, theme: monacoThemeNames.dark })
      .tokens.flat();
    expect(tokens.find((token) => token.content === 'Invoice')?.color?.toUpperCase()).toBe(
      '#B7A6E8',
    );
    expect(tokens.find((token) => token.content === 'total')?.color?.toUpperCase()).toBe('#8CB5EB');
  },
);

it('keeps semantic colors when TextMate installs the Monaco theme', () => {
  const theme = highlighter.getTheme(monacoThemeNames.dark);
  for (const role of [
    'function',
    'method',
    'type',
    'struct',
    'parameter',
    'property',
    'constant',
  ]) {
    const rule = editorTheme.rules.find((item) => item.token === role);
    expect(theme.settings.find((item) => item.scope === role)?.settings.foreground).toBe(
      `#${rule?.foreground}`,
    );
  }
});
