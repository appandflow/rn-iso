# Release recovery

Edge cases and one-time procedures pulled out of [RELEASE.md](../RELEASE.md)
so the normal path stays short. Come here from the step that failed.

## A tag exists but npm does not have it

`npm view stim-cli version` is the source of truth for "what was last
released" -- a publish can fail after the tag is pushed, leaving the tag
ahead of the registry. If `git describe --tags --abbrev=0` is higher than
the published version, a previous release got tagged but never landed.
**Retry that publish at the existing version** (RELEASE.md section 4 step 7,
or the manual fallback below) rather than incrementing past it.

## One publish failed after another succeeded

Do NOT bump the version to retry -- re-run only the failed publish at the
same version. The tagged workflow already skips exact versions that exist,
so re-running the whole workflow is also safe.

## Manual publish fallback

The same commands the workflow runs, for when it cannot. 2FA is on, so each
publish prompts for an OTP. These use `pnpm publish`, which packs with pnpm
and therefore substitutes the `workspace:` ranges the packages declare; a bare
`npm publish` from a package directory would upload them verbatim:

```bash
npm whoami                                          # confirm login; if 401, `npm login` first
pnpm --filter @stim-cli/core publish --access public --otp <code>
pnpm --filter @stim-cli/cache publish --access public --otp <code>
pnpm --filter @stim-cli/metro publish --access public --otp <code>
pnpm --filter @stim-cli/expo-build-cache publish --access public --otp <code>
pnpm --filter stim-cli publish --access public --otp <code>
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

While no stable exists, everything publishes to `latest` (see RELEASE.md
section 1). The historical `next` tags went stale twice under the old
instructions and were removed on 2026-09-01. Post-stable dist-tag selection
is tracked as issue #165. Repairs are `npm dist-tag add|rm` with an OTP.
