# Complexity Ceiling Design

## Goal

Prevent functions from exceeding a cyclomatic complexity of 80 and simplify
all current violations.

## Design

Add Oxlint's ESLint-compatible `complexity` rule to `.oxlintrc.json` with
severity `error` and `max: 80`. The repository already uses Oxlint 1.80.0. The
rule has existed since Oxlint 1.37.0, so no dependency change is needed.

Run the rule across the full repository. Refactor each violation into named,
single-purpose functions. Preserve behavior, call order, output contracts, and
dependency injection. Do not add rule overrides, disable directives, or
grandfathered files.

Use local phase functions inside `runIos` and `runAndroid`. The functions can
share the existing run state without large parameter objects. Keep the current
module-level deployment, verification, upload, and result helpers unchanged.

## Alternatives

- A higher ceiling would reduce the first refactor but would permit functions
  that Hunk already treats as excessive.
- A lower ceiling would improve more code but would expand the task beyond the
  referenced change.

## Verification

Run the complexity rule before and after the refactor. Then run formatting,
lint, type checks, the full test suite, and the build. Run end-to-end tests only
if a changed function affects a real tool workflow.
