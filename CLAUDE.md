# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**ReactuLLM SDD** (`reactullm-sdd`) — Spec-Driven Development for React. A single
TOML spec is deterministically compiled into a red Vitest/Jest + React Testing
Library suite plus an implementation brief for an implementing agent. TypeScript
CLI + library; it emits test *source as strings* and never imports React or a
test runner itself.

## The one invariant (do not break)

> The LLM never writes test code as free text. It only fills a typed schema.
> Test source is always rendered from templates. Coverage completeness is proven
> by mechanical cross-checks in plain code — never by asking the model whether it
> covered everything.

When changing the pipeline, preserve this. In particular keep the AST safety gate
(`safety.ts`) and the mechanical coverage checks (`checks.ts`) authoritative — a
failed gate must commit nothing.

## Commands

```bash
npm run sdd            # run the CLI (tsx src/cli.ts)
npm run gen:contract   # regenerate reactullm-pyllum.contract.json
npm run build          # tsc -> dist/
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run test:watch     # vitest watch
```

## Layout

- `src/cli.ts` — CLI entrypoint (bin: `react-sdd`)
- `src/tomlSpec.ts` — parse TOML spec, `toTestPlan()`
- `src/planner.ts` — request-mode plan (model fills the Zod schema)
- `src/safety.ts` — AST gate rejecting imports/eval/reflection
- `src/checks.ts` — mechanical coverage validation
- `src/renderer.ts` — renders the red `.test.tsx` from templates
- `src/runs.ts` — commits run artifacts (`DONE.json`, `.sdd-runs.json`)
- `src/schema.ts` — Zod schemas / typed plan
- `test/` — Vitest tests

## Dangerous commands — require manual approval

The project `.claude/settings.json` gates destructive shell commands. `rm`,
`git rm`, `git clean`, `git reset --hard`, `git restore`, `git branch -D`,
`git push`, `mv`, `sudo`, recursive `chmod`/`chown`, and similar are configured
to **prompt for confirmation** (`ask`), and a few catastrophic forms
(`rm -rf /`, `git push --force`) are **denied outright**. Do not attempt to work
around these — if such a command is genuinely needed, run it plainly and let the
user approve it. Prefer non-destructive alternatives (e.g. `git switch` over
force operations) where possible.
