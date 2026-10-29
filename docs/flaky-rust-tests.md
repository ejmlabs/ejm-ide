# IDE test reliability

The reliability workflow runs on macOS after pushes to main and daily. It
collects the frontend suite and compares two independent Vitest runs in one job.
Another job runs Cargo and cargo-nextest twice each, including ignored tests, and
runs doctests. A failure in either job does not prevent the other from running.
A failure, missing or skipped case, ambiguous identity, or incomplete report
fails the check; comparable tests with mixed outcomes are still named.

The collector loads test modules and global setup, as a normal Vitest run does.
Each native attempt uses a disposable index workspace. Language-server tests
copy their own fixture, so concurrent servers cannot modify one another's data.
The workflow provisions rust-analyzer, Pyright, TypeScript, Ruby LSP, and gopls.

To reproduce on macOS, prepare the pinned sibling harness and install the IDE's
npm dependencies as in [development](development.md). Install cargo-nextest
0.9.124 and the language servers above. From the repository root, run
`python3 scripts/frontend_flake_check.py /tmp/ide-frontend-flakes`; from
`src-tauri`, run `python3 ../scripts/flake_check.py /tmp/ide-rust-flakes`.
Each output directory must be new. The workflow uploads available logs and
reports for seven days, including acceptance reports from each native attempt.
The comparison steps have individual deadlines to leave time for upload.

The workflow disables incremental builds and debug symbols to reduce disk use;
debug assertions remain enabled. A hosted macOS run must confirm that the job
fits the runner's disk and time limits. The human-admitted PR gate is unchanged.
