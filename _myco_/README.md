# _myco_

This directory holds the **plan / test / architecture artifacts** for this
project, surfaced by [myco](https://github.com/kkrazy/myco) (the Claude
Code dashboard).

Files here are safe to **commit and push** — they migrate to other
sessions (or other developers) cloning this repo.

## Files

- `plan.json` — open and completed plan items, including comments + voters.
- `test.json` — verification plan items + comments.
- `architecture.md` — long-form architecture notes (editable directly).
- `critic.md` — project-specific critic rules + anti-patterns
  appended to the critic's system prompt on every `▶ Run` review
  (fr-89 Phase 1). Seeded from the myco-shipped default template
  (`server/templates/critic.md` in the myco repo) on first use,
  then **project-owned**: template updates do NOT overwrite local
  edits. Hand-edit to teach the critic project-specific lessons,
  or delete the file and the next critic run will re-seed it from
  the latest myco default.

Generated and rewritten on each artifact mutation (refresh, mark, vote,
comment, item delete). Hand-editing the files is fine — myco reads them
on the next load and reconciles with the in-memory copy.
