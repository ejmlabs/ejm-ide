# remove-obsolete-internal-docs

Remove obsolete internal design notes and keep current public guidance linked.

## Verification

Prepared from main `76879ea01dea506f72b143939915a9475a37e528` on October 19,
2026. The UX diary's current setup, navigation, chat, editor-group, Git,
extension, and inspection rules are covered by `DESIGN.md`, `PRODUCT.md`, and
the maintained subsystem guides. No current rule required a second guide.

- All 60 local Markdown links and four heading anchors in the five maintained
  documents resolve. Both package-audit links use current design guidance.
- No maintained guide requires a removed file. The design artifact names the
  retired diary only to explain this change.
- Strict OpenSpec validation and whitespace checks pass.
- Runtime, public-site content and build inputs, retained kits and provenance,
  workflows, dependencies, licenses, and canonical review snapshots are unchanged.

This changes public contributor guidance. No runtime or site behavior changed,
so native, browser, and site builds were not repeated. Local checks do not claim
hosted CI, live-site, release, or publication acceptance.
