# Release process

How to cut a new version of `rn-iso` to npm and GitHub. Keep this in sync with
what we actually do — when something changes, update both this file and the
real workflow at the same time.

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
npm test                          # all tests pass
node bin/cli.js --help            # CLI loads cleanly
node bin/cli.js --version         # matches package.json (0.2.0 shipped with 0.1.0 once)
git status --short                # working tree clean
```

If `git status` isn't clean, commit / discard before tagging.

## 3. Cut the release

1. **Bump the version** in `package.json` to the value chosen in step 1 — `bin/cli.js` reads from `package.json`, so no other source file needs it. Then run `npm install --package-lock-only` so `package-lock.json`'s own `version` field (it duplicates `package.json`'s) matches; a stale lockfile version doesn't break anything functionally, but it's confusing to publish alongside a bumped `package.json`.
2. **Verify the npm tarball** ships only what should ship:
   ```bash
   npm pack --dry-run
   ```
   The `files` whitelist in `package.json` controls this — keep it tight (`bin`, `src`, `skill`, `LICENSE`, `README.md`).
3. **Commit** with a `chore: X.Y.Z — <one-line summary>` title. The body can be terse; the GitHub release notes carry the real changelog.
4. **Tag and push:**
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push
   git push --tags
   ```
5. **Write the GitHub release notes.** Drop them into a temp file (so multi-line markdown survives the shell), then:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/rn-iso-X.Y.Z-notes.md
   ```
   Sections: `New`, `Removed (breaking)`, `Fixes`, `Docs`, `Migration notes` (if any). Skip empty sections. Link prior commits with `[<short-sha>](https://github.com/janicduplessis/rn-iso/commit/<sha>)`.
6. **Publish to npm:**
   ```bash
   npm whoami                  # confirm login; if 401, `npm login` first
   npm publish                 # add --otp <code> if 2FA prompts
   ```
   2FA is on for this account, so `npm publish` will prompt for an OTP. If publishing from CI later, switch to an automation token.
7. **Smoke-test the published version** from a scratch directory:
   ```bash
   cd /tmp && npx rn-iso@latest --version
   ```

## 4. After the release

- Leave `package.json` at the just-released version. The next release bumps it as part of its own step 3; we don't carry a `-dev` suffix between releases.

## Don't

- Force-push tags. Cut a new version.
- Skip the `npm pack --dry-run` step. Untracked files have shipped before.
