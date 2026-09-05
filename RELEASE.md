# Release process

How to cut a new version of `stim-cli` to npm and GitHub. Keep this in sync with
what we actually do — when something changes, update both this file and the
real workflow at the same time.

## 0. The five packages

```
packages/core                @stim-cli/core                shared primitives (cache roots, cache key, registration)
packages/stim-cli              stim-cli                      the CLI
packages/cache               @stim-cli/cache               cache provider contract and tier coordination
packages/expo-build-cache    @stim-cli/expo-build-cache    Expo build cache provider
packages/metro               @stim-cli/metro               shared Metro transform cache + log reporter
```

**Every package carries the same version and is published together** -- the
caches and the CLI are one product, and a shared version beats a compatibility
matrix. A release with no changes to a package still publishes it.

Run every command from the repo root unless a step says otherwise. Each
package ships its own README in its own tarball; the root README is a landing
page and is not copied anywhere.

## 1. Decide the version

The source of truth for "what was last released" is the npm registry, not
local git tags — a publish can fail after the tag is pushed, leaving the tag
ahead of what's actually on npm. Post-stable, the highest published version
can sit on either the `latest` or the `next` dist-tag, so check both and take
the semver-higher one. Pull it and list commits since the matching tag:

```bash
git fetch --tags
if last=$(npm view stim-cli dist-tags --json 2>/dev/null | node -e '
  const { latest, next } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const parse = (v) => {
    const [core, pre] = v.split("-");
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : null };
  };
  const compare = (l, r) => {
    const a = parse(l), b = parse(r);
    for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
    if (!a.pre && !b.pre) return 0;
    if (!a.pre) return 1;
    if (!b.pre) return -1;
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
      const x = a.pre[i], y = b.pre[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (x === y) continue;
      return /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x < y ? -1 : 1;
    }
    return 0;
  };
  const versions = [latest, next].filter(Boolean);
  if (!versions.length) process.exit(1);
  process.stdout.write(versions.reduce((hi, v) => (compare(v, hi) > 0 ? v : hi)));
'); then
  echo "Last published: v$last"
  git log "v$last..HEAD" --oneline
else
  echo "No published stim-cli version"
  git log --oneline
fi
```

An npm `E404` means a first release for that package name: complete the
first-publication bootstrap in
[docs/release-recovery.md](./docs/release-recovery.md) before pushing the tag.

Use `X.Y.Z-rc.N` for a release candidate. The workflow computes the publish
dist-tag itself from the tag and the registry: it reads `npm view
@stim-cli/core version` -- the first package every run publishes, not
`stim-cli`, the last -- as its stable-or-not signal, and a candidate
publishes to `next` instead of `latest` only when that signal is already a
stable version, so a plain `npm install` never regresses to a candidate.
Every other publish -- a stable version, or a candidate published while no
stable release exists yet, including a first-ever publish (`E404`) -- lands
on `latest`, which is what installs resolve. Probing the first-published
package instead of the last fails safe if a release dies mid-run: the worst
case is a candidate landing on `next` a little early, never a candidate
stomping `latest` on packages that already went stable. The gate assumes a
partial release is always completed or recovered (see
[docs/release-recovery.md](./docs/release-recovery.md)) before the next tag
lands; the workflow does not check that on its own. A tag higher than the
published version
means a release never landed: see
[docs/release-recovery.md](./docs/release-recovery.md) before bumping.

Look at every commit in the list and decide:

- **Patch** (`0.2.0 -> 0.2.1`) — bug fixes, doc-only changes, internal refactors with no user-visible effect.
- **Minor** (`0.2.0 -> 0.3.0`) — new commands, new flags, additions to existing commands. Pre-1.0, breaking changes also go here; a new major is reserved for 1.0 stabilization or a deliberate grouped-breaking-changes cut.
- **Major** (`0.x -> 1.0`, `1.x -> 2.0`) — only post-1.0, or when intentionally cutting a 1.0.

If anything in the list is breaking, call it out under "Removed (breaking)" /
"Migration notes" in the draft release notes.

Before pre-flight, write `docs/releases/X.Y.Z.md`. This is the evidence index
for the QA gate, not a post-tag changelog exercise. Use the sections `New`,
`Removed (breaking)`, `Fixes`, `Docs`, and `Migration notes`, omitting empty
sections. An expedited candidate also has a `QA` section. Link prior commits with
`[<short-sha>](https://github.com/appandflow/stim/commit/<sha>)`, and say
which package a line concerns when it is not the CLI. The version commit later
includes this already-reviewed file.

## 2. Prepare and verify the exact candidate

Start from `main`, fully up to date with `origin/main`. Before candidate
preparation, `git status --short` may show only the draft
`docs/releases/X.Y.Z.md`.

1. **Bump the version in lockstep.** All five `package.json` files carry the
   same number, and `dist/cli.mjs` reads it from its own `package.json`:

   ```bash
   pnpm run release:prep X.Y.Z
   ```

   The script refuses a malformed version, one that does not come after the
   version the five packages already carry, and a tree whose versions already
   disagree. It rewrites the five `version` fields together, refreshes the
   lockfile, then re-reads the manifests to confirm all five landed on the new
   version and that the lockfile still matches them, and leaves the candidate
   uncommitted and untagged. If any of that fails it puts the five manifests
   back at the version they had, so a failed run is never half-bumped.

   Nothing else moves. The packages depend on each other through pnpm's
   `workspace:` protocol, so there is no dependency range to bump: pnpm
   substitutes the real version when it packs (verified in step 3).
   `pnpm run release:prep --check` audits that shape -- five versions in
   lockstep, every internal range a bare `workspace:` range -- without changing
   anything.

   Confirm all five moved:

   ```bash
   grep -H '"version"' packages/*/package.json
   ```

2. **Install and run the full pre-flight against those exact files.** The
   expedited RC lane in section 3 replaces this command list with its short
   preflight; do not combine the two lanes informally.

   ```bash
   pnpm install --frozen-lockfile
   pnpm run format:check
   pnpm run lint
   pnpm run build
   pnpm run typecheck
   pnpm run knip
   pnpm test
   pnpm run test:e2e
   pnpm run test:runtime
   node packages/stim-cli/dist/cli.mjs --help
   node packages/stim-cli/dist/cli.mjs guide agent
   test "$(node packages/stim-cli/dist/cli.mjs --version)" = "X.Y.Z"
   ```

3. **Verify each npm tarball** ships only what should ship, that each one
   carries its own README, and that every `@stim-cli/*` line names a real
   version. Pack with `pnpm`, never `npm`: the release workflow publishes
   pnpm-packed tarballs, and `npm pack` prints the unsubstituted `workspace:`
   ranges rather than what actually publishes.

   ```bash
   out=$(mktemp -d)
   for p in core cache metro expo-build-cache stim-cli; do
     tgz=$(cd "packages/$p" && pnpm pack --pack-destination "$out" | tail -1)
     echo "== $p ($(tar -tzf "$tgz" | wc -l | tr -d ' ') files)"
     tar -tzf "$tgz" | grep -E 'README|LICENSE'
     tar -xzOf "$tgz" package/package.json | grep -E '"version"|"@stim-cli/'
   done
   rm -rf "$out"
   ```

   Keep the `files` whitelists tight (`dist`, `shim`, `skill`, `LICENSE`,
   `README.md` for the CLI; `dist`, `README.md`, `LICENSE` for the other
   packages). Every published JavaScript entry lives under `dist/`. A
   `workspace:` range in that output means the tarball was not packed by pnpm;
   stop and fix the packing before publishing.

4. **Inspect the candidate diff.** `git status --short` should contain only the
   five package manifests and the draft release notes. `pnpm-lock.yaml` no
   longer moves with a version bump -- it records the internal edges as
   `workspace:` specifiers and `link:` targets, neither of which carries a
   version. Resolve anything else before QA.

## 3. Pre-tag QA gate

Do not create the version commit or tag until this gate passes. The candidate
prepared in section 2 is the one every command must exercise. Start with the
automated native suites described in [`docs/e2e-and-ci.md`](./docs/e2e-and-ci.md):

```bash
node test/e2e/native/run-native-e2e.mjs --framework <bare|expo> --platform <ios|android>
node test/e2e/native/run-cache-e2e.mjs --framework <bare|expo> --platform <ios|android> --summary /tmp/cache-summary.json
```

Choose the matrix from the changes since the last published tag:

| Change since the last release                                           | Required evidence                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Command lifecycle, worktrees, devices, or framework detection           | `loop` for each affected framework/platform                      |
| Log collection, error queries, or timeline behavior                     | field protocol logs row on each affected platform                |
| Build, cache, fingerprint, Pods, Metro, single-flight, or `gc` behavior | `caches` for each affected platform and each affected Metro mode |
| Project detection, prebuild, monorepo, or hoisted-dependency behavior   | field protocol on a representative real repository               |
| Remote device, tunnel, or remote build-cache behavior                   | field protocol with the affected authenticated provider          |
| Release build or JS/APK swap behavior                                   | field protocol release row on each affected platform             |
| Android variant or artifact selection                                   | field protocol on a real flavored Android repository             |
| Launch status, remedies, or interaction UX                              | field protocol launch-evidence row on each affected platform     |

A minor release runs every applicable row. A patch may omit unaffected rows,
but the release report must name each omission and why the diff cannot affect
it. A major release runs the full matrix on at least two representative real
repositories.

The manual rows and report format are in
[`docs/field-test-protocol.md`](./docs/field-test-protocol.md). Do not repeat
the cache suite by hand: attach its machine-readable summary. Attach the loop
suite result and log for each loop row. Run manual rows with the built candidate
CLI as described by the protocol, never `stim-cli@latest`. Every claim in the
draft release notes needs a matching automated check or manual observation.
Missing evidence is not a pass.

Before continuing:

- [ ] every required row passed, or is explicitly omitted with a diff-based reason
- [ ] every automated summary and manual observation is attached to the release PR or task
- [ ] every release-note claim points to evidence
- [ ] zero CRITICAL findings remain
- [ ] every HIGH finding is fixed, or accepted explicitly and named in the release notes

### Expedited RC lane

Use this lane only when the user or release owner explicitly asks for an
expedited, quick, or no-QA release. It shortens feedback for a prerelease; it is
not available for a stable version.

All of these conditions are required:

- The target version has a prerelease suffix such as `-rc.N`.
- Every included change was merged through a reviewed pull request with its
  blocking CI green.
- No CRITICAL or HIGH finding remains open for the included changes.
- The changes since the last published version do not alter package boundaries,
  version preparation, tarball packing, trusted publishing, or the Release
  workflow. Those changes use the full lane.
- The registry and tag checks in section 1 show no partial release to recover.

Complete section 2 steps 1, 3, and 4. In place of section 2 step 2, run this
short preflight against the bumped candidate:

```bash
pnpm install --frozen-lockfile
pnpm run release:prep --check
pnpm run build
node packages/stim-cli/dist/cli.mjs --help >/dev/null
node packages/stim-cli/dist/cli.mjs guide agent >/dev/null
test "$(node packages/stim-cli/dist/cli.mjs --version)" = "X.Y.Z"
```

The tarball inspection remains mandatory. It is the proof that the exact files
about to publish have the intended versions, package contents, READMEs, and no
unsubstituted `workspace:` ranges.

The expedited lane may omit the other local checks in section 2 step 2 and all
of the pre-tag native, runtime, end-to-end, and manual rows in section 3. Record
that choice in the release note instead of implying those checks passed:

```markdown
## QA

Expedited RC authorized on YYYY-MM-DD. Omitted locally before the version
commit: format:check, lint, typecheck, knip, unit tests, test:e2e, test:runtime,
and the pre-tag native/manual matrix. Retained before the version commit:
candidate build, CLI version/help/guide, and tarball inspection. Retained after
push: exact-release-commit CI, including its format, lint, build, typecheck,
knip, unit, cross-platform e2e, and published-runtime jobs.
```

Section 4 is unchanged. In particular, commit and push the candidate without a
tag, wait for every blocking CI job on that exact commit, and only then create
the immutable tag and publish through the normal workflow. A failed short
preflight, tarball check, or exact-commit CI ends the expedited lane; fix it and
repeat the affected gate rather than waiving it.

## 4. Cut the release

1. **Freeze the evidence and notes.** Compare the draft release notes against
   the completed QA report one last time. If a claim or accepted HIGH needs a
   correction, update the notes and repeat the affected gate rows now.
2. **Commit** with a `chore: X.Y.Z — <one-line summary>` title. The body can be terse; the GitHub release notes carry the real changelog.
3. **Push the commit without a tag**, then remember the exact candidate SHA:

   ```bash
   git push
   release_commit=$(git rev-parse HEAD)
   ```

4. **Wait for blocking CI on that exact commit.** The Node 22 and Node 24 jobs
   plus `published runtime (node 20.19.4)` must all be green:

   ```bash
   run_id=$(gh run list --workflow CI --commit "$release_commit" --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run view "$run_id" --json url --jq '.url'
   gh run watch "$run_id" --exit-status
   test "$(git rev-parse HEAD)" = "$release_commit"
   ```

   A fix creates a new commit and repeats this step. Never tag a commit that
   has not passed this exact-commit check.

5. **Tag and push the proven commit:**

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   One tag for the repo, not one per package: the packages share a version, so
   a per-package tag would only say the same thing five times.

6. **Publish the already-reviewed release notes in
   `docs/releases/X.Y.Z.md`.** This committed file is the single source of
   truth: the website's changelog page is GENERATED from it at site build
   (`website/scripts/gen-changelog.mjs`, triggered by the Docs deploy on any
   push touching `docs/releases/`), and the GitHub release is created from the
   same file:
   ```bash
   tail -n +2 docs/releases/X.Y.Z.md > /tmp/notes.md
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/notes.md
   ```
   Add `--prerelease` when `X.Y.Z` contains a prerelease suffix.
   Do not add claims here. Once the tag is remote, a correction requires a new
   version; never move or force-push the published tag.
7. **Publish to npm.** Pushing the tag in step 5 triggers the
   `Release` workflow, which publishes all FIVE packages via OIDC trusted
   publishing (no token, `--provenance`) once the run is approved in the
   `release` environment. If the current GitHub identity is an allowed
   reviewer, approve the deployment directly with `gh` instead of waiting for
   a separate human action. First resolve the pending environment ID and
   confirm that `current_user_can_approve` is `true`, then approve it:

   ```bash
   gh api repos/appandflow/stim/actions/runs/<run-id>/pending_deployments \
     --jq '.[] | [.environment.id, .environment.name, .current_user_can_approve] | @tsv'
   gh api --method POST repos/appandflow/stim/actions/runs/<run-id>/pending_deployments \
     -F 'environment_ids[]=<environment-id>' \
     -f state=approved \
     -f comment='Approved after exact-SHA CI and preflight passed.'
   ```

   If the current identity cannot approve, use Actions -> the waiting run ->
   Review deployments -> check `release` -> Approve and deploy. That approval
   replaces the OTP. ALWAYS hand the approver the direct link to the waiting
   run -- do not make them hunt for it:

   ```bash
   gh run list --workflow Release --limit 1 --json databaseId,url,status
   ```

   Send the `url` (the run page has Review deployments -> `release` ->
   Approve and deploy). The workflow packs the five tarballs with pnpm, checks
   that no `workspace:` range survived the pack, skips an exact package version
   that already exists, computes the dist-tag (section 1) and publishes every
   package to it, then verifies all five registry versions and that dist-tag.
   A NEW package, a failed publish, or
   a provenance rejection: see
   [docs/release-recovery.md](./docs/release-recovery.md).

8. **Smoke-test the published versions** from a scratch directory:
   ```bash
   version=X.Y.Z
   cd /tmp && npx "stim-cli@$version" --version
   cd /tmp && npx "stim-cli@$version" guide agent >/dev/null
   npm view "stim-cli@$version" readme | head -c 200        # NOT "No README data found!"
   npm view "@stim-cli/core@$version" version
   npm view "@stim-cli/cache@$version" version
   npm view "@stim-cli/expo-build-cache@$version" version
   npm view "@stim-cli/metro@$version" version
   ```
   A missing README on npm means the package directory lacks one
   ([docs/release-recovery.md](./docs/release-recovery.md)).

## 5. After the release

- Leave every `package.json` at the just-released version. The next release
  bumps them as part of its own section 2, step 1; we don't carry a `-dev`
  suffix between releases.

## Don't

- Force-push tags. Cut a new version.
- Skip the tarball check in section 2, step 3. Untracked files have shipped
  before, and it is the only place a `workspace:` range would be caught by hand.
- Use the expedited RC lane for a stable version, release-workflow change, or a
  candidate with an unresolved CRITICAL or HIGH finding.
- Treat “no QA” as permission to skip exact-release-commit CI, candidate version
  verification, or tarball inspection.
- Publish one package at a new version and leave the others behind. The shared
  version is the compatibility statement; a partial release makes it a lie.
