# Concise Agent Guide Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the long `CLAUDE.md` guide with a concise `AGENT.md` guide and keep `CLAUDE.md` as a compatible symlink.

**Architecture:** Preserve the numbered rules referenced by source comments, but reduce each rule to its durable constraint. Use a relative symlink so both guide paths work in every checkout.

**Tech Stack:** Markdown, POSIX symlink, npm workspace checks.

---

### Task 1: Replace the guide

**Files:**

- Create: `AGENT.md`
- Replace: `CLAUDE.md`

**Step 1: Write the concise guide**

Create `AGENT.md` with the project purpose, development commands, architecture rules, numbered invariants, and release guidance. Keep the guide under 160 lines.

**Step 2: Replace the old path with a symlink**

Remove the regular `CLAUDE.md` file and create a relative `CLAUDE.md -> AGENT.md` symlink.

**Step 3: Verify the migration**

Run: `test -L CLAUDE.md && test "$(readlink CLAUDE.md)" = AGENT.md && cmp AGENT.md CLAUDE.md`

Expected: exit status 0 with no output.

Run: `wc -l AGENT.md`

Expected: fewer than 160 lines.

### Task 2: Run repository checks

**Files:**

- Verify: `AGENT.md`
- Verify: `CLAUDE.md`

**Step 1: Check formatting**

Run: `npm run format:check`

Expected: exit status 0.

**Step 2: Inspect the final diff**

Run: `git diff --check && git diff -- AGENT.md CLAUDE.md`

Expected: no whitespace errors and only the approved guide migration.
