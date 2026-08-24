# Release process

How to cut a new version of `rn-iso` to npm and GitHub. Keep this in sync with
what we actually do — when something changes, update both this file and the
real workflow at the same time.

## 0. The three packages

```
packages/rn-iso              rn-iso                      the CLI
packages/expo-build-cache    @rn-iso/expo-build-cache    Expo build cache provider
packages/metro-cache         @rn-iso/metro-cache         shared Metro transform cache
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
`packages/rn-iso/README.md` exists rather than only the root one. The root
`README.md` is a landing page pointing at the packages; it does not need to be
copied anywhere.

## 1. Decide the version

The source of truth for "what was last released" is the npm registry, not
local git tags — a publish can fail after the tag is pushed, leaving the tag
ahead of what's actually on npm. Pull the published version and list commits
since the matching tag:

```bash
git fetch --tags
last=$(npm view rn-iso version)
echo "Last published: v$last"
git log "v$last..HEAD" --oneline
```

If `git describe --tags --abbrev=0` is *higher* than `v$last`, a previous
release got tagged but never landed on npm. **Retry that publish before
bumping again** (re-run step 6 with the existing version) rather than
incrementing past it.

Look at every commit in the list and decide:

- **Patch** (`0.2.0 -> 0.2.1`) — bug fixes, doc-only changes, internal refactors with no user-visible effect.
- **Minor** (`0.2.0 -> 0.3.0`) — new commands, new flags, additions to existing commands. **Pre-1.0, breaking changes also go here** (e.g. 0.1 -> 0.2 was a major surface trim that landed as a minor). On 0.x a breaking change does *not* force a major — bumping to a new major is reserved for 1.0 stabilization or a deliberate grouped-breaking-changes cut.
- **Major** (`0.x -> 1.0`, `1.x -> 2.0`) — only post-1.0, or when intentionally cutting a 1.0.

If anything in the list is breaking, plan to call it out under "Removed
(breaking)" / "Migration notes" in the release notes (step 5 below).

## 2. Pre-flight

From `main`, fully up to date with `origin/main`:

```bash
npm test                                          # all tests pass
node packages/rn-iso/bin/cli.js --help            # CLI loads cleanly
node packages/rn-iso/bin/cli.js --version         # matches package.json (0.2.0 shipped with 0.1.0 once)
git status --short                                # working tree clean
```

If `git status` isn't clean, commit / discard before tagging.

## 3. Cut the release

1. **Bump the version in lockstep.** All three `package.json` files carry the
   same number, and `bin/cli.js` reads it from its own `package.json`, so no
   source file needs editing:
   ```bash
   npm version X.Y.Z --workspaces --no-git-tag-version
   npm install --package-lock-only
   ```
   `--workspaces` bumps all three; `--no-git-tag-version` keeps the commit and
   the tag as step 3 and step 4 below, where the ordering is deliberate. The
   `npm install` refreshes `package-lock.json`, which duplicates every
   workspace's version -- a stale lockfile breaks nothing functionally, but is
   confusing to publish alongside a bumped manifest.

   Then confirm all three moved, and that the peer ranges in the two cache
   packages still name a version of `rn-iso` that exists:
   ```bash
   grep -H '"version"' packages/*/package.json
   grep -H '"rn-iso"' packages/expo-build-cache/package.json packages/metro-cache/package.json
   ```
   The cache packages declare `rn-iso` as an OPTIONAL peer, so a range naming
   an unpublished version does not break an install -- it only misleads. Widen
   it (`>=X.Y.Z`) when a release adds something the caches depend on, such as a
   new field in the cache manifest.
2. **Verify each npm tarball** ships only what should ship, and that each one
   carries its own README (a package with no `README.md` in its own directory
   publishes with "No README data found" on npm):
   ```bash
   for p in rn-iso expo-build-cache metro-cache; do
     echo "== $p"; (cd "packages/$p" && npm pack --dry-run 2>&1 | grep -E 'README|Tarball|total files')
   done
   ```
   The `files` whitelist in each `package.json` controls this — keep it tight
   (`bin`, `src`, `skill`, `LICENSE`, `README.md` for the CLI; `index.js` and
   `README.md` for the caches).
3. **Commit** with a `chore: X.Y.Z — <one-line summary>` title. The body can be terse; the GitHub release notes carry the real changelog.
4. **Tag and push:**
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push
   git push --tags
   ```
   One tag for the repo, not one per package: the packages share a version, so
   a per-package tag would only say the same thing three times.
5. **Write the GitHub release notes.** Drop them into a temp file (so multi-line markdown survives the shell), then:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/rn-iso-X.Y.Z-notes.md
   ```
   Sections: `New`, `Removed (breaking)`, `Fixes`, `Docs`, `Migration notes` (if any). Skip empty sections. Link prior commits with `[<short-sha>](https://github.com/janicduplessis/rn-iso/commit/<sha>)`. Say which package a line is about when it is not the CLI.
6. **Publish to npm, `rn-iso` first.** The two cache packages name it as a peer
   and their READMEs link to it, so a registry that has a cache package but not
   the CLI version it points at is the wrong order to be interrupted in:
   ```bash
   npm whoami                                          # confirm login; if 401, `npm login` first
   npm publish --workspace rn-iso                      # add --otp <code> if 2FA prompts
   npm publish --workspace @rn-iso/expo-build-cache
   npm publish --workspace @rn-iso/metro-cache
   ```
   2FA is on for this account, so each `npm publish` will prompt for an OTP.
   Both scoped packages are already published as public, so they need no
   `--access` flag; a brand-new scoped package would need `--access public` on
   its first publish. If publishing from CI later, switch to an automation token.

   If one publish fails after another succeeded, do NOT bump the version to
   retry — re-run only the failed publish at the same version.
7. **Smoke-test the published versions** from a scratch directory:
   ```bash
   cd /tmp && npx rn-iso@latest --version
   npm view rn-iso readme | head -c 200        # NOT "No README data found!"
   npm view @rn-iso/expo-build-cache version   # same number as rn-iso
   npm view @rn-iso/metro-cache version        # same number as rn-iso
   ```
   `npm view rn-iso` reported "No README data found" for every release up to
   0.14.0, because the only README lived at the repo root while the package
   publishes from `packages/rn-iso`. Check it, rather than assuming a README in
   the repo means a README on npm.

## 4. After the release

- Leave every `package.json` at the just-released version. The next release bumps them as part of its own step 3; we don't carry a `-dev` suffix between releases.

## Don't

- Force-push tags. Cut a new version.
- Skip the `npm pack --dry-run` step. Untracked files have shipped before.
- Publish one package at a new version and leave the others behind. The shared
  version is the compatibility statement; a partial release makes it a lie.
