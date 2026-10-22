# Accepted UI pin adoption

The proposed pin selects accepted UI commit `d4f7b06fbca61f2311a9b81971fbc6afb99b2821`,
tree `e753fae8a4d697dd952fed7459c12903b67c34f7`. Source prerequisites #17, #18,
#19 and #20 are accepted. The active manifest and source supplement bind
13 install metadata records and 272 changed files to retained exact bytes.
All 285 bindings were verified. Consumer pin acceptance remains pending.
These snapshots remain inert; product source and the site are unchanged.

## Historical bootstrap record

The following record describes the earlier pin.

# Public UI source review inputs

The active owner pin is `.github/ui-source.json`. It selects the already protected `ejmlabs/ejm-ui` main commit `79a1aa8b1075f834717bc0c0299dc2c41a22b966`. The existing shared workflow reads that selection from protected base, never from the pull request head. It then exports the exact owner source and installs that sibling with `npm ci --ignore-scripts`.

`manifest.json` binds all thirteen complete install metadata files to their owner Git blobs, sizes and SHA-256 hashes. The ordinary mode-644 fixtures retain original source bytes, workspace manifests, root lockfile and license. The chunk manifest records the same extraction identities. These copies are static review data. Never import, execute, install or package them. The workflow source snapshots under `.github/review-context` remain unchanged.

This prerequisite adds no product dependency or runtime code. It enables the existing optional source checkout contract for later review. The planned site migration needs a newer accepted owner revision, complete changed-source prerequisites, a separate protected-base pin update and its own normal checks before admission. This bootstrap does not authorize those later changes, paid review, merge or deployment.
