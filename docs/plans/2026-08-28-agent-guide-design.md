# Concise agent guide design

## Goal

Replace the long repository guide with a short guide that agents can scan quickly.

## Content

`AGENTS.md` will keep only durable information:

- The project purpose and normal command flow.
- The fixed command and option surface.
- Core architecture and safety rules.
- Documentation, test, release, and commit requirements.

The guide will remove implementation history, the full file inventory, resolved incidents, and repeated explanations. Source files and existing documents can continue to refer to `CLAUDE.md` because that path will remain available.

## File layout

`AGENTS.md` will contain the guide. `CLAUDE.md` will be a relative symlink to `AGENTS.md`.

## Verification

- Confirm that `CLAUDE.md` is a symlink with target `AGENTS.md`.
- Confirm that both paths return identical content.
- Run the repository format check for the Markdown change.
