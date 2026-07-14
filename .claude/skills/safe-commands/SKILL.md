---
name: safe-commands
description: Project policy on destructive shell/git commands (rm, git rm, git reset --hard, git push, etc.) and how they must be approved. Read before running any command that deletes, moves, force-updates, or rewrites files, git history, or refs in this repo.
---

# Safe commands

This repo treats a set of shell/git commands as dangerous. They are enforced in
`.claude/settings.json` (`permissions.deny` / `permissions.ask`), so the harness
prompts or blocks automatically — this skill explains the intent so you avoid
triggering them needlessly.

## Denied outright (never run)
- `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf ~/*`
- `git push --force` / `git push -f`

## Require manual approval (prompt every time)
- `rm`, `rmdir`, `mv`, `truncate`, `dd`
- `git rm`, `git clean`, `git reset --hard`, `git restore`, `git checkout -- <path>`
- `git branch -D`, `git push`, `git stash drop`, `git stash clear`, `git filter-branch`
- recursive `chmod -R` / `chown -R`, `find ... -delete`, `find ... -exec rm`
- `sudo` (anything)

## How to behave
1. Prefer non-destructive alternatives: `git switch` instead of force checkouts,
   moving files with the Edit/Write tools or a plain `git mv` (still gated),
   deleting a single tracked file only when explicitly asked.
2. When a destructive command is genuinely required, run it as-is and let the
   user approve the prompt. Do not rewrite it to dodge the rule (e.g. splitting
   an `rm -rf` across steps, or aliasing).
3. Never disable or edit the deny/ask lists in `.claude/settings.json` to make a
   command run without approval unless the user explicitly asks for that change.
4. If a command is denied, stop and tell the user rather than searching for a
   workaround.
