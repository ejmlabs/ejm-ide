# Native Rust test reliability

The reliability workflow runs the native host tests on macOS on main and daily.
It runs the normal all-targets Cargo tests twice, cargo-nextest 0.9.124 twice,
and doctests twice. It names tests with both a pass and a failure in complete
nextest reports. A failed or incomplete run fails the job; it is never retried
into a pass. Cargo suite outcomes are compared separately because nextest runs
each test in its own process. This cannot name shared-process races or prove
that tests are free of flakes. Tests ignored by the normal gate remain ignored.
The human-admitted PR gate is unchanged.

To reproduce on macOS, prepare the pinned sibling harness and install the IDE's
npm dependencies as in [development](development.md). Install nextest with
`cargo install --locked --version 0.9.124 cargo-nextest`, then from `src-tauri`
run `python3 ../scripts/flake_check.py /tmp/ide-rust-flakes` with a new output
directory. Logs and JUnit reports are kept there locally. The workflow streams
logs and named inconsistencies to Actions; the temporary reports are not kept
after the runner exits. The workflow disables incremental builds and debug
symbols to reduce disk use; debug assertions remain enabled. Existing local Rust
builds can exceed the hosted runner's documented disk capacity. A hosted macOS
run must confirm that this job fits before it can be considered operational.

Nextest 0.9.124 omits ignored tests from its JUnit reports. Tests reported in
only one attempt make the comparison incomplete; tests omitted from both
are not classified or counted as passes.
