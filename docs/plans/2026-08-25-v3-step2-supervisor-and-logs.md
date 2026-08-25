# rn-iso v3 Step 2: Supervisor and Logs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `rn-iso start` spawns a detached per-workspace supervisor that hosts the dev server and captures structured NDJSON logs; `logs` queries them; `stop` tears the runtime down non-destructively; `status` reports it.

**Architecture:** One detached supervisor process per workspace. Bare RN: Metro hosted in-process with our reporter (full structure). Expo: `expo start` spawned as a child, stdout parsed into NDJSON (inferred structure). Both CLIs discard a config-set reporter, so capture follows hosting — see the spec's corrected "log pipeline" section.

**Tech Stack:** Node 20+, ESM (CLI), CJS (`@rn-iso/metro`). No new dependencies. Ecosystem packages resolved from the PROJECT's node_modules via createRequire; rn-iso depends on neither.

## Global Constraints

Same as step 1 (ESM, ASCII, exec.js wrapper, config lock, RN_ISO_HOME, fail closed, no new deps). Plus:
- The supervisor must never outlive usefulness silently: every exit path writes a final NDJSON record and clears its global registration.
- No command blocks by default; waiting is explicit (`start` waits for health because that is its contract; `logs` exits unless `--follow`).

---

## Contract 1: NDJSON record

One JSON object per line. Required fields:

```
{ "ts": <ms epoch int>, "src": "metro"|"client"|"device"|"build", "level": "debug"|"info"|"warn"|"error"|"fatal", "msg": <string> }
```

Optional: `event` (producer event name, e.g. Metro reporter type), `stack` (array of `{file,line,column,fn}`), `proc` (device process), `raw: true` (parsed from stdout, structure inferred), `marker: true` (resets the `--errors` window: written on bundle-build-done and app launch).

Files, per workspace (paths from `src/paths.js`):
```
<root>/.rn-iso/logs/metro.ndjson    bundler + expo-child stdout
<root>/.rn-iso/logs/client.ndjson   forwarded client console/errors (bare in-process)
<root>/.rn-iso/logs/device.ndjson   simctl log stream / logcat (written in steps 3/4)
<root>/.rn-iso/logs/build-ios.ndjson / build-android.ndjson (steps 3/4)
<root>/.rn-iso/logs/supervisor.log  the supervisor's own stdio (raw, not ndjson)
```

## Contract 2: supervisor state

- `<root>/.rn-iso/supervisor.pid` — the supervisor's pid, plain text.
- `<root>/.rn-iso/state.json` — `{ "supervisor": { "pid", "port", "mode": "bare-inproc"|"expo-child", "startedAt", "serverPid"? } }`, written atomically (temp+rename). Later steps add `lastBuild` beside `supervisor`.
- Global: project record in `~/.rn-iso/config.json` gains `supervisor: { pid, port, startedAt }` via new locked mutators `setSupervisor(root, info)` / `clearSupervisor(root)` in `src/config.js` (owned by Task C). This is what lets `worktree remove` and `status --all` find a supervisor whose worktree was deleted from under it.

## Contract 3: health and identity

"Healthy" = `resolveProjectMetro(port, root)` returns `{ metro }` — the existing identity check, never a bare /status probe. A foreign listener is `metroConflict`, exactly as v2's `up` treated it.

---

### Task A: NDJSON core + `logs` command

**Files:** Create `src/ndjson.js`, `src/logs-query.js`, `src/commands/logs.js`; tests `test/ndjson.test.js`, `test/logs-query.test.js`, `test/logs-command.test.js`. Do NOT touch bin/cli.js (orchestrator wires it).

**Produces:**
- `createNdjsonWriter(file)` -> `{ write(record), close() }`. Appends; creates parent dirs on first write; stamps `ts` if absent; never throws on write failure (a logging failure must not kill the supervisor — count drops, surface in close()).
- `parseNdjsonLine(line)` -> record or null (corrupt lines are skipped, not fatal).
- `queryLogs({ dir, sources, minLevel, since, grep, tail, errorsOnly, now })` -> merged records ascending by ts across all files. `since` accepts `30s|5m|2h` strings (pure parser `parseSince`). `errorsOnly`: level error|fatal with ts >= the last `marker:true` record's ts (no marker = whole log).
- `followLogs({ dir, onRecord })` -> polling tail (500ms), returns stop().
- `logs` command: `--source <s...>`, `--level <l>`, `--since <d>`, `--grep <re>`, `--tail <n>`, `--errors`, `--follow`, `--json`. Human output one line per record: `HH:MM:SS.mmm level src msg`; `--json` emits raw NDJSON. Exits 0 with nothing found (empty is the pass condition).

### Task B: `@rn-iso/metro` (rename + reporter)

**Files:** `git mv`-equivalent by orchestrator is NOT available — create `packages/metro/` with package name `@rn-iso/metro`, move index.js content, delete `packages/metro-cache/`. Update `test/cache-packages.test.js` imports and the registered cache `name` only if tests demand. Keep CJS; keep zero rn-iso imports.

**Produces:** existing `sharedCacheStores(name)` unchanged, plus `ndjsonReporter({ dir })` -> a Metro `Reporter` (`{ update(event) }`) writing Contract-1 records to `dir/metro.ndjson` and `dir/client.ndjson`:
- `client_log` events -> client.ndjson, level from `event.level` (log->info), msg joined from `event.data`, `stack` passed through when present.
- `bundling_error` / `transformer_error` -> metro.ndjson level error with the message extracted.
- `bundle_build_done` -> metro.ndjson info with `marker: true`.
- `unstable_server_log` -> level from event, msg from data.
- everything else -> level debug, `event` preserved, msg best-effort. Unknown event shapes must never throw.
`dir` defaults to `join(process.cwd(), '.rn-iso', 'logs')`.

### Task C: supervisor + `start`

**Files:** Create `src/supervisor/run.js`, `src/supervisor/server-bare.js`, `src/supervisor/server-expo.js`, `src/commands/start.js`; modify `src/config.js` (setSupervisor/clearSupervisor, inside the lock); tests. Do NOT touch bin/cli.js, stop.js, status.js.

- `run.js`: argv `--root <path> --port <n>`. Detect ecosystem with `detectIsExpo(root)`. Write pid + state.json + global registration BEFORE starting the server (crash-safe, mirroring device records). SIGTERM/SIGINT: stop server (close Metro / SIGTERM the expo child's process group), write final record, clear registration, exit 0. Unexpected server death: final record, clear, exit 1.
- `server-bare.js`: createRequire from the PROJECT resolves `metro`, `@react-native/dev-middleware`, `@react-native-community/cli-server-api`. Mirror RN's runServer.js (~60 lines): loadConfig with port override, our `ndjsonReporter` (imported from `@rn-iso/metro`), createDevServerMiddleware + createDevMiddleware wired into `Metro.runServer`. A missing package -> structured error naming which one (the project may be Expo misdetected, or node_modules absent).
- `server-expo.js`: spawn `<root>/node_modules/.bin/expo` `['start','--port',port]`, cwd root, `stdin: 'ignore'`, detached:false (dies with supervisor group). Pipe stdout/stderr lines -> Contract-1 records into metro.ndjson (`raw: true`; level inferred from leading `ERROR`/`WARN`/`error:`/`warn:`, else info). No other flags, ever.
- `start` command: root; reuse or reserve port (existing reserveMetroPort, including the foreign-holder re-reservation from up.js); if already healthy -> no-op exit 0 printing facts; else spawn `process.execPath [run.js ...]` detached, stdio to supervisor.log, unref; poll health up to `--wait <s>` (default 60); on success print `{port, supervisorPid, mode, logs}` (+ `--json`); on timeout exit 1 with the tail of supervisor.log's last 5 lines and the log path.

### Task D: `stop` rewrite + `status` extension

**Files:** Rewrite `src/commands/stop.js`; extend `src/commands/status.js` + `src/status.js`; tests. Do NOT touch bin/cli.js, config.js (read via existing getters + workspace state.json).

- `stop` (v3 semantics, flagless, non-destructive): (1) supervisor from state.json/config — verify pid alive AND its recorded root matches this project before signalling; SIGTERM the process group; wait up to 10s; (2) if no supervisor but something answers the recorded port, fall back to v2's identity-verified `resolveProjectMetro` + `killMetroTree` (keep `--force` for the unproven-listener case, exactly as today); (3) shut down (never delete) the owned device via teardown shutdown path; (4) free the port: remove `metroPort` from the project record; (5) clear supervisor registration + stale pid/state files. Each step reports; already-stopped is success, not error.
- `status`: per environment add `supervisor: {pid, mode, startedAt, healthy} | null` and `logs: {dir, errorsSinceMarker}` (count via queryLogs errorsOnly). Keep every existing field; `--json` stays stable otherwise.

### Task E (orchestrator): wiring + docs + live verification

bin/cli.js registrations (logs, start; stop already registered), guide topics, SKILL.md, README; live-verify per CLAUDE.md item 9 on a real bare-RN fixture and an Expo project; commit sequencing.

## Out of scope for step 2
Device log collectors (steps 3/4 attach them), `ios`/`android`, removal of `up`/`device`/`release`/`shutdown` (step 3), symbolication (follow-up: reporter passes stacks through as-is this step).
