# Release process

How to cut a new version of `stim-cli` to npm and GitHub. Keep this in sync with
what we actually do — when something changes, update both this file and the
real workflow at the same time.

## 0. The four packages

```
packages/core                @stim-cli/core                shared primitives (cache roots, cache key, registration)
packages/stim-cli              stim-cli                      the CLI
packages/expo-build-cache    @stim-cli/expo-build-cache    Expo build cache provider
packages/metro               @stim-cli/metro               shared Metro transform cache + log reporter
```

**Every package in this repo carries the same version and is published
together.** The caches and the CLI are one product -- a cache package registers
itself through the CLI's manifest, and the CLI trims what the caches wrote -- so
a version that tells you which CLI a cache was built against is worth more than
one that counts that package's own changes. A release with no changes to a
package still publishes it; the cost is a version number, and the alternative is
a compatibility matrix nobody maintains.

Run every command from the repo root unless a step says otherwise. Each package
has its own README, and each README ships in its own tarball -- npm reads a
package's README from that package's directory and nowhere else, which is why
`packages/stim-cli/README.md` exists rather than only the root one. The root
`README.md` is a landing page pointing at the packages; it does not need to be
copied anywhere.

## 1. Decide the version

The source of truth for "what was last released" is the npm registry, not
local git tags — a publish can fail after the tag is pushed, leaving the tag
ahead of what's actually on npm. Pull the published version and list commits
since the matching tag:

```bash
git fetch --tags
last=$(npm view stim-cli version)
echo "Last published: v$last"
git log "v$last..HEAD" --oneline
```

If `git describe --tags --abbrev=0` is _higher_ than `v$last`, a previous
release got tagged but never landed on npm. **Retry that publish before
bumping again** (re-run step 7 with the existing version) rather than
incrementing past it.

Look at every commit in the list and decide:

- **Patch** (`0.2.0 -> 0.2.1`) — bug fixes, doc-only changes, internal refactors with no user-visible effect.
- **Minor** (`0.2.0 -> 0.3.0`) — new commands, new flags, additions to existing commands. **Pre-1.0, breaking changes also go here** (e.g. 0.1 -> 0.2 was a major surface trim that landed as a minor). On 0.x a breaking change does _not_ force a major — bumping to a new major is reserved for 1.0 stabilization or a deliberate grouped-breaking-changes cut.
- **Major** (`0.x -> 1.0`, `1.x -> 2.0`) — only post-1.0, or when intentionally cutting a 1.0.

If anything in the list is breaking, plan to call it out under "Removed
(breaking)" / "Migration notes" in the release notes (step 5 below).

## 2. Pre-flight

From `main`, fully up to date with `origin/main`:

```bash
pnpm run build                                      # generate the published ESM files
pnpm test                                           # all tests pass
node packages/stim-cli/dist/cli.mjs --help          # CLI loads cleanly
node packages/stim-cli/dist/cli.mjs --version       # matches package.json
git status --short                                  # working tree clean
```

If `git status` isn't clean, commit / discard before tagging.

## 3. Cut the release

1. **Bump the version in lockstep.** All four `package.json` files carry the
   same number, and `dist/cli.mjs` reads it from its own `package.json`, so no
   source file needs editing:

   ```bash
   pnpm -r --filter './packages/*' exec npm version X.Y.Z --no-git-tag-version
   pnpm install --lockfile-only
   ```

   The filtered `exec` bumps all four; `--no-git-tag-version` keeps the commit and
   the tag as their own later steps, where the ordering is deliberate. The
   `pnpm install` refreshes `pnpm-lock.yaml`, which duplicates every
   workspace's version -- a stale lockfile breaks nothing functionally, but is
   confusing to publish alongside a bumped manifest.

   Then confirm all four moved, and that the dependency ranges between the
   packages still name versions that exist:

   ```bash
   grep -H '"version"' packages/*/package.json
   grep -H '"@stim-cli/' packages/stim-cli/package.json packages/expo-build-cache/package.json packages/metro/package.json
   ```

   Internal workspace dependencies are published as ordinary semver ranges, so
   every referenced `@stim-cli/*` version must exist in the registry by the time
   the release finishes.

2. **Refresh the skill's version stamp.** The last line of
   `packages/stim-cli/skill/SKILL.md` names the version it was synced with;
   update it to X.Y.Z (agents compare it against `npx stim-cli --version` to
   detect a stale skill copy).
3. **Verify each npm tarball** ships only what should ship, and that each one
   carries its own README (a package with no `README.md` in its own directory
   publishes with "No README data found" on npm):
   ```bash
   for p in core stim-cli expo-build-cache metro; do
     echo "== $p"; (cd "packages/$p" && npm pack --dry-run 2>&1 | grep -E 'README|Tarball|total files')
   done
   ```
   The `files` whitelist in each `package.json` controls this — keep it tight
   (`bin`, `src`, `skill`, `LICENSE`, `README.md` for the CLI; `index.js` and
   `README.md` for the caches).
4. **Commit** with a `chore: X.Y.Z — <one-line summary>` title. The body can be terse; the GitHub release notes carry the real changelog.
5. **Tag and push:**
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push
   git push --tags
   ```
   One tag for the repo, not one per package: the packages share a version, so
   a per-package tag would only say the same thing four times.
6. **Write the release notes in `docs/releases/X.Y.Z.md`** -- the single
   source of truth: the website's changelog page is GENERATED from these files
   at site build (`website/scripts/gen-changelog.mjs`, triggered by the Docs
   deploy on any push touching `docs/releases/`), and the GitHub release is
   created from the same file:
   ```bash
   tail -n +2 docs/releases/X.Y.Z.md > /tmp/notes.md
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/notes.md
   ```
   Sections: `New`, `Removed (breaking)`, `Fixes`, `Docs`, `Migration notes` (if any). Skip empty sections. Link prior commits with `[<short-sha>](https://github.com/appandflow/stim-cli/commit/<sha>)`. Say which package a line is about when it is not the CLI.
7. **Publish to npm.** Pushing the tag (previous step) triggers the
   `Release` workflow, which publishes all FOUR packages via OIDC trusted
   publishing (no token, `--provenance`) once you APPROVE the run in the
   `release` environment on GitHub (Actions -> the waiting run -> Review
   deployments -> check `release` -> Approve and deploy) -- that approval
   replaces the OTP. ALWAYS hand the approver the direct link to the waiting
   run -- do not make them hunt for it:

   ```bash
   gh run list --workflow Release --limit 1 --json databaseId,url,status
   ```

   Send the `url` (the run page has Review deployments -> `release` ->
   Approve and deploy). Two learned-the-hard-way requirements: every
   package.json must carry a `repository` field matching this repo (a
   provenance publish is REJECTED without it, E422), and a NEW package must
   be published once by hand first -- npm's trusted-publisher settings live
   on the package page, which does not exist until then. For the first
   `stim-cli` release, create the `@stim-cli` npm organization, publish all four
   packages manually in dependency order, then configure each package's trusted
   publisher for `appandflow/stim-cli`, workflow `release.yml`, environment
   `release`. The same commands are the manual fallback for later releases:

   ```bash
   npm whoami                                          # confirm login; if 401, `npm login` first
   pnpm --filter @stim-cli/core publish --access public --otp <code>
   pnpm --filter @stim-cli/metro publish --access public --otp <code>
   pnpm --filter @stim-cli/expo-build-cache publish --access public --otp <code>
   pnpm --filter stim-cli publish --access public --otp <code>
   ```

   2FA is on for this account, so each `npm publish` will prompt for an OTP.
   Keeping `--access public` on every scoped publish is harmless and makes the
   first release explicit. OIDC trusted publishing replaces tokens and OTPs in
   CI after the package-level trusted publishers are configured.

   If one publish fails after another succeeded, do NOT bump the version to
   retry — re-run only the failed publish at the same version.

8. **Smoke-test the published versions** from a scratch directory:
   ```bash
   cd /tmp && npx stim-cli@latest --version
   npm view stim-cli readme | head -c 200        # NOT "No README data found!"
   npm view @stim-cli/expo-build-cache version   # same number as stim-cli
   npm view @stim-cli/metro version              # same number as stim-cli
   ```
   `npm view stim-cli` reported "No README data found" for every release up to
   0.14.0, because the only README lived at the repo root while the package
   publishes from `packages/stim-cli`. Check it, rather than assuming a README in
   the repo means a README on npm.

## 4. After the release

- Leave every `package.json` at the just-released version. The next release bumps them as part of its own step 3; we don't carry a `-dev` suffix between releases.

## Don't

- Force-push tags. Cut a new version.
- Skip the `npm pack --dry-run` step. Untracked files have shipped before.
- Publish one package at a new version and leave the others behind. The shared
  version is the compatibility statement; a partial release makes it a lie.
