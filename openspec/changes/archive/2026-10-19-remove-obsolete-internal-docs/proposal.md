# Proposal

## Why

Old mockup briefs and a dated UX diary repeat current guidance and retain a
private brand-checkout prerequisite. Public contributors need one current set
of instructions, with links that survive removal of those notes.

## What Changes

- Remove the two obsolete internal design briefs and the dated UX review.
- Keep current interaction and editor-group rules in `DESIGN.md`, `PRODUCT.md`,
  and the maintained subsystem guides. Point the package audit to those guides.
- Replace active references to the old site brief with current design guidance
  and the retained asset provenance manifest. Update the documentation index.

## Capabilities

### New Capabilities

None. This is documentation cleanup; `.openspec.yaml` sets `skip_specs: true`.

### Modified Capabilities

None. Product behavior and public APIs do not change.

## Impact

`ejm-ide` owns the affected documentation and contributor instructions. No
shared public interface, dependency direction, or downstream consumer changes.
Runtime code, website build inputs, kits, workflows, dependencies, licenses,
canonical review snapshots, and asset provenance stay unchanged.

Public source guidance changes. The website content and build are unaffected;
this change does not publish a site, release, package, or repository.
