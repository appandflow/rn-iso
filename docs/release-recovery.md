# Release recovery

Edge cases and one-time procedures pulled out of [RELEASE.md](../RELEASE.md)
so the normal path stays short. Come here from the step that failed.

## A tag exists but npm does not have it

The npm registry is the source of truth for "what was last released" -- a
publish can fail after the tag is pushed, leaving the tag ahead of the
registry. Post-stable, the last-published version can sit on either the
`latest` or the `next` dist-tag; RELEASE.md section 1 shows the
`npm view stim-cli dist-tags --json` invocation that checks both and picks
the semver-higher one. If `git describe --tags --abbrev=0` is higher than
that, a previous release got tagged but never landed. **Retry that publish
at the existing version** (RELEASE.md section 4 step 7, or the manual
fallback below) rather than incrementing past it.

## One publish failed after another succeeded

Do NOT bump the version to retry -- re-run only the failed publish at the
same version. The tagged workflow already skips exact versions that exist,
so re-running the whole workflow is also safe. That safety flips once a
newer release has since shipped: the smoke-test step's dist-tag check now
fails the run red, because the freshly computed `DIST_TAG` no longer matches
what actually got published, and a backfill publish for the old version can
re-point `latest` or `next` backwards onto it -- confirm with
`npm dist-tag ls <package>` afterward if you do this.

## Manual publish fallback

For when the workflow cannot run: the same five publishes, by hand and in
dependency order. `pnpm publish` packs with pnpm, so it substitutes the
`workspace:` ranges the packages declare -- a bare `npm publish` from a package
directory would upload them verbatim. Compute the dist-tag exactly as the
workflow does (RELEASE.md section 1): `latest`, unless this version is a
release candidate AND `npm view @stim-cli/core version` is already a stable
release, in which case `next`. 2FA is on, so each publish prompts for an OTP:

```bash
npm whoami                                          # confirm login; if 401, `npm login` first
pnpm --filter @stim-cli/core publish --access public --tag <dist-tag> --otp <code>
pnpm --filter @stim-cli/cache publish --access public --tag <dist-tag> --otp <code>
pnpm --filter @stim-cli/metro publish --access public --tag <dist-tag> --otp <code>
pnpm --filter @stim-cli/expo-build-cache publish --access public --tag <dist-tag> --otp <code>
pnpm --filter stim-cli publish --access public --tag <dist-tag> --otp <code>
```

## First publication of a NEW package

npm's trusted-publisher settings live on the package page, which does not
exist until the package is published once -- so a new package must be
published by hand (OTP) before the workflow can cover it. Then configure the
package's trusted publisher for `appandflow/stim`, workflow `release.yml`,
environment `release`. The workflow's already-exists skip makes the next
tagged release pick it up cleanly.

For a from-scratch bootstrap (first release ever): confirm all the package
names are available, use the intended first version, review the full release
diff, create the `@stim-cli` npm organization, publish all five packages
manually in dependency order, then configure each package's trusted
publisher as above -- all before pushing the first tag.

## Provenance publish rejected (E422)

Every package.json must carry a `repository` field matching this repo; a
provenance publish is REJECTED without it.

## npm shows "No README data found!"

npm reads a package's README from that package's directory and nowhere
else. Every release up to 0.14.0 shipped without one because the only
README lived at the repo root. The smoke-test step checks this; if it
fires, the package directory is missing its README.

## Stale or wrong dist-tags

The workflow computes the publish dist-tag itself (RELEASE.md section 1): a
release candidate lands on `next` only when `@stim-cli/core`'s registry
`latest` is already stable; every other publish -- including every publish
before 1.0.0 stable ships -- lands on `latest`. If a dist-tag still ends up
stale or wrong, repair it with `npm dist-tag add|rm` and an OTP.
