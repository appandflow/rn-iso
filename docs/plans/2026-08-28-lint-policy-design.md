# Lint policy design

## Goal

Keep the repository free of lint warnings and make future warnings fail CI.
Expand lint coverage where Oxlint provides high-signal checks for this Node.js,
TypeScript, and Vitest monorepo.

## Policy

- Keep `correctness` rules at error severity.
- Keep `suspicious` findings visible as warnings, and run Oxlint with
  `--deny-warnings` so CI rejects every warning.
- Enable the built-in Import, Node, Promise, and Vitest plugins.
- Fix valid findings. Use narrow rule options or file overrides when a rule
  conflicts with an external API or test structure.
- Trial individual performance rules and enable only rules with clear value.
- Do not enable the complete `pedantic`, `perf`, `style`, `restriction`, or
  `nursery` categories.
- Do not add type-aware linting in this change. That mode requires a new
  dependency and a separate policy review.

## Implementation

Update the Oxlint configuration and scripts first. Run the expanded lint set to
produce the complete finding list. Apply automatic safe fixes, then review and
fix the remaining findings manually. Keep changes limited to lint findings and
their required configuration.

## Verification

Run the repository format check, lint, build, typecheck, dead-code check, unit
tests, and cross-platform end-to-end tests. The lint command must report zero
warnings and zero errors.
