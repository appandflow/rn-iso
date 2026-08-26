# rn-iso TypeScript + tooling migration

Branch `ts-migration` (isolated worktree). Base: v1.1.0. Goal: whole repo on
TypeScript + oxlint + oxfmt + tsdown + vitest(-on-rolldown), tests colocated in
`__tests__/`, and CI updated to run the new toolchain.

## Constraints

- **Cache packages `@rn-iso/metro` + `@rn-iso/expo-build-cache` MUST emit CJS.**
  `metro.config.js` and the Expo provider load them via `require()`. tsdown
  `format: 'cjs'`.
- **Node >=22 everywhere** (consumers AND dev). Node 20 is EOL (2026-04-30), so
  raising the floor excludes a dead runtime and unifies dev/consumer versions.
  tsdown target node22 (no downleveling). This is a breaking engines bump ->
  the release is **1.2.0**. CI matrix [22, 24].
- **Public surface stable**: bin, the `./cache-manifest` export, and the
  `rn-iso <command>` CLI surface are unchanged. `exports`/`bin` point at `dist/`.
  Node 22 floor; no real consumers yet, so ships as MINOR **1.2.0**.
- ASCII rule relaxes (TS files may use whatever oxfmt emits) BUT keep the
  existing no-smart-punctuation discipline if oxfmt is fine with it; oxfmt is
  the arbiter of style now.

## Phases

0. **Scaffold + recipe**: add devDeps, tsconfig(s), vitest.config (rolldown),
   tsdown.config per package, oxlint/oxfmt config, root scripts. Prove the whole
   chain on a small converted slice. Produce the exact per-file conversion recipe.
1. **rn-iso/src -> .ts** (70 files), `tsc --noEmit` clean.
2. **rn-iso tests -> vitest .ts, colocated `src/__tests__/`** (50 files). DONE: vitest 1398 green. Production `typecheck` is strict-0; test files run type-stripped by vitest. Strict test-typechecking (`typecheck:tests` -> tsconfig.test.json, ~332 friction errors from tests that intentionally pass partial/invalid inputs) is an OPT-IN RATCHET, not in blocking CI -- tighten later by casting deliberate-malformed inputs.
3. **Cache packages -> .ts**, tsdown builds CJS; their tests.
4. **tsdown build all**; verify built `bin` + `./cache-manifest` resolve and run.
5. **oxlint + oxfmt** config + fix.
6. **CI**: ci.yml = install -> oxlint -> oxfmt --check -> typecheck -> vitest ->
   build -> test:e2e. Keep e2e-native.yml.
7. Green -> bump all packages to 1.2.0 (engines >=22) -> merge to main.
   6b. **Validate CI for real**: push branch, watch Actions until ci.yml is green on the runner, trigger e2e-native.yml once (bare+expo x ios+android) to prove the native path, not just YAML parse.

## STATUS: COMPLETE (2026-08-26)

All 7 phases done. CI green on the runner (node 22 + 24), PR #17. Shipping 1.2.0.

## Definition of done (the goal)

All packages TypeScript; `tsc`/vitest/tsdown/oxlint/oxfmt all green; CI runs
the new toolchain; merged to main.
