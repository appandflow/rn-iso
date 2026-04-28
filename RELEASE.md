# Release process

How to cut a new version of `rn-iso` to npm and GitHub. Keep this in sync with
what we actually do — when something changes, update both this file and the
real workflow at the same time.

## Versioning

- Semver. `MAJOR.MINOR.PATCH`.
  - Patch: bug fixes, doc-only changes, internal refactors with no user-visible effect.
  - Minor: new commands, new flags, additions to existing commands.
  - Major: removing commands/flags, on-disk config shape changes that aren't auto-migrated, anything that would break someone running the previous version against the same `~/.rn-iso/config.json`.
- Pre-1.0, breaking changes can ship in a minor (e.g. 0.1 → 0.2 was a major surface trim). Call them out clearly under "Removed (breaking)" in the release notes.

## Pre-flight

Run from `main`, fully up to date with `origin/main`:

```bash
npm test                                        # all tests pass
node bin/cli.js --help                          # CLI loads cleanly
node bin/cli.js --version                       # matches package.json (0.2.0 shipped with 0.1.0 once)
git status --short                              # working tree clean
git log "$(git describe --tags --abbrev=0)..HEAD" --oneline   # changes since last tag
```

If `git status` isn't clean, commit / discard before tagging.

## Cut the release

1. **Bump the version** in `package.json`. No other version files to update.
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

## After the release

- Bump the local working tree's `package.json` to the next planned version + `-dev` suffix (or leave at the just-released version — we currently leave it). Decide once and document here when it's settled.
- If a critical bug is discovered post-publish, ship a patch release rather than `npm unpublish`.

## Don't

- `npm unpublish` after the 72-hour window unless you're cleaning up a literal mistake. Cut a patch instead.
- Force-push tags. Cut a new version.
- Skip the `npm pack --dry-run` step. Untracked files have shipped before.
