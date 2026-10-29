# Design

## Context

The native host is supported on macOS. The normal PR gate is human-admitted.

## Goals / Non-Goals

Detect intermittent outcomes without accepting a later pass as success. This
does not replace platform verification or prove the absence of flakes.

## Decisions

Run all-targets Cargo tests twice for shared-process behavior, pinned
cargo-nextest twice for structured per-test reports, and doctests twice.
The JUnit comparison checks identities, counts, exits and missing evidence.
Nextest supplies structured reports; the small adapter compares runs and retains
both failures, which Cargo's normal test output cannot identify reliably.

## Risks / Trade-offs

Nextest isolates individual tests and cannot name shared-process races. Cargo
suite disagreement is reported separately. Logs stream to Actions; temporary
JUnit reports are not retained after the runner exits. Hosted macOS behavior
must be validated after the workflow is admitted and merged. Existing local
Rust builds can exceed hosted runner disk capacity. The job disables incremental
compilation and debug symbols to reduce space, while retaining debug assertions;
a hosted run must confirm that the job fits.
