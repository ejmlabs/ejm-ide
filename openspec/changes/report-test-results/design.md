# Design

## Context

The shared gate compares test outcomes from independent runs on the same commit.

## Goals / Non-Goals

Emit the existing Vitest results when requested. Do not retry tests or alter product behavior.

## Decisions

Use Vitest's built-in JSON and default reporters when the environment selects a path. Leave its defaults intact otherwise. This avoids an extra reporter dependency.

## Risks / Trade-offs

Reports can contain test output. The shared gate must sanitize and bound them before retention.
