# Design

## Context

The native host is supported on macOS. The normal PR gate is human-admitted.

## Goals / Non-Goals

Detect intermittent outcomes without accepting a later pass as success. This
does not replace platform verification or prove the absence of flakes.

## Decisions

Run all-targets Cargo tests for shared-process behavior as well as cargo-nextest
and doctests. See the [test reliability guide](../../../docs/flaky-rust-tests.md)
for the current comparison and retention behavior.

## Risks / Trade-offs

Nextest isolates individual tests and cannot reproduce shared-process races.
Hosted macOS behavior must be validated after the workflow is admitted and
merged. Existing local Rust builds can exceed hosted runner disk capacity.
