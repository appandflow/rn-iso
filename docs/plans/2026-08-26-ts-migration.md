# rn-iso TypeScript + tooling migration

Branch `ts-migration` (isolated worktree). Base: v1.1.0. Goal: whole repo on
TypeScript + oxlint + oxfmt + tsdown + vitest(-on-rolldown), tests colocated in
`__tests__/`, and CI updated to run the new toolchain.

## Constraints
- **Cache packages `@rn-iso/metro` + `@rn-iso/expo-build-cache` MUST emit CJS.**
  `metro.config.js` and the Expo provider load them via `require()`. tsdown
  `format: 'cjs'`.
- **Published output must run on Node >=20** (consumers unchanged): tsdown
  compiles TS -> JS targeting node20, published `dist/`. DEV requires Node >=22
  (native TS). Keep consumer `engines.node >=20`; document the >=22 dev floor.
- **Public surface stable**: bin, the `./cache-manifest` export, and the
  `rn-iso <command>` CLI surface are unchanged. `exports`/`bin` point at `dist/`.
  If stable -> a MINOR (1.2.0), not a major.
- ASCII rule relaxes (TS files may use whatever oxfmt emits) BUT keep the
  existing no-smart-punctuation discipline if oxfmt is fine with it; oxfmt is
  the arbiter of style now.

## Phases
0. **Scaffold + recipe**: add devDeps, tsconfig(s), vitest.config (rolldown),
   tsdown.config per package, oxlint/oxfmt config, root scripts. Prove the whole
   chain on a small converted slice. Produce the exact per-file conversion recipe.
1. **rn-iso/src -> .ts** (70 files), `tsc --noEmit` clean.
2. **rn-iso tests -> vitest .ts, colocated `src/**/__tests__/`** (50 files).
3. **Cache packages -> .ts**, tsdown builds CJS; their tests.
4. **tsdown build all**; verify built `bin` + `./cache-manifest` resolve and run.
5. **oxlint + oxfmt** config + fix.
6. **CI**: ci.yml = install -> oxlint -> oxfmt --check -> typecheck -> vitest ->
   build -> test:e2e. Keep e2e-native.yml.
7. Green -> version bump -> merge to main.

## Definition of done (the goal)
All packages TypeScript; `tsc`/vitest/tsdown/oxlint/oxfmt all green; CI runs
the new toolchain; merged to main.
