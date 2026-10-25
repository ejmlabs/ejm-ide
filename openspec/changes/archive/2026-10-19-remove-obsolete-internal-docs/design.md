# Design

## Context

The two `.impeccable` briefs describe earlier mockups and a private brand
checkout. `docs/ux-review.md` mixes current rules with dated test counts.
`DESIGN.md`, `PRODUCT.md`, and current subsystem guides already carry the
interaction contracts. See the proposal for the cleanup's purpose.

## Goals / Non-Goals

**Goals:** keep one maintained guide for each subject, preserve current UX
rules, and repair every active reference before removing the old notes.

**Non-Goals:** change product behavior, adopt shared UI packages, remove kits,
rewrite the package audit, or claim new runtime or publication verification.

## Decisions

1. Keep interaction and editor-group guidance in `DESIGN.md`. The current
   `PRODUCT.md` principles and subsystem guides remain in place. Point both
   package-audit links there and add it to the docs index. A new UX guide would
   repeat the same rules and create another maintenance target.
2. Keep screenshot hashes, provenance, notices, licenses, and committed assets.
   Update the website skill and design guide to maintain those current inputs
   instead of the deleted site brief. The optional kit refresh is unchanged.
3. Use focused local Markdown link/anchor, strict OpenSpec, whitespace, and
   changed-path checks. No runtime or site input changes, so repeating native,
   browser, or site builds would not verify a new behavior.

## Risks / Trade-offs

- A current rule could exist only in the diary. Compare its coverage with the
  current guides before removal and carry any missing rule into its owner.
- A deleted filename could still be required. Search active tracked files and
  validate local Markdown targets after the edits.
- Old verification counts disappear with the diary. Git history retains the
  evidence; current guides must state current contracts without presenting a
  dated browser sample as new verification.

## Migration Plan

Land one documentation-only PR after normal human admission and all required
checks. Revert the commit to restore the previous documents. No runtime,
deployment, package, or visibility migration is needed.
