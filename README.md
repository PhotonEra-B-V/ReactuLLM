# ReactuLLM SDD — Spec-Driven Development for React

<img width="720" height="405" alt="Screenshot 2026-07-11 at 18 05 21" src="https://github.com/user-attachments/assets/eb6697bd-6e4d-4e1c-8711-fecbc2bfe601" />

"Vybe code no more" do LLM agentic coding the right way.

A single TOML spec is the source of truth. From it we **deterministically
compile** a red component/behaviour test suite (the specification) plus an
implementation brief for an implementing agent. This is the structural twin of
the Python `pyllm.bdd` pipeline — same philosophy, same guarantees, adapted to
Jest (or Vitest) + React Testing Library.

It is framework-agnostic and app-agnostic: the CLI only emits test *source* —
it never imports React or a test runner — so it drops into any React codebase
that has an RTL-based test setup.

## The one invariant

> The LLM never writes test code as free text. It only fills a typed schema.
> Test source is always rendered from templates. Coverage completeness is proven
> by mechanical cross-checks in plain code — never by asking the model whether it
> covered everything.

Everything below is in service of that invariant.

## Pipeline

```
 .toml spec ──▶ parse ──▶ plan ──▶ scanPlan ──▶ validatePlan ──▶ render ──▶ commit run
                          │                                        │              │
                 plan mode: toTestPlan()                  <slug>.test.tsx        DONE.json      (completion marker)
                 (deterministic, NO LLM)                  <slug>.plan.json       .sdd-runs.json (append-only history)
                 request mode: planFromSpec()             BRIEF_<slug>.md
                 (structured output fills the schema)     sdd-setup.ts    (shared RTL harness, written once)
```

| Stage | File | What it guarantees |
|-------|------|--------------------|
| **parse** | `tomlSpec.ts` | One TOML spec → API surface, rules, edge cases, mermaid `[[sequences]]`, and (plan mode) hand-written `[[cases]]`. Auto-detects mode from the presence of `[[cases]]`. |
| **plan** | `tomlSpec.toTestPlan()` / `planner.ts` | A typed `TestPlan`. Plan mode is deterministic; request mode has the model fill the Zod schema — it never emits test text. |
| **scanPlan** | `safety.ts` | AST gate: rejects imports, `require`, `eval`/`Function`, dynamic `import()`, `process`/`globalThis`/`window` reflection & exfil, and non-parseable input — in **both** modes, before anything runnable is written. |
| **validatePlan** | `checks.ts` | Mechanical coverage: every scenario, sequence message, and rule/edge id must be claimed by some case's `covers`; unknown ids and duplicate test names fail the build. |
| **render** | `renderer.ts` | A red `.test.tsx` from templates. Each test's first line is `bddPending()` — it throws until the implementer deletes that one line. |
| **commit run** | `runs.ts` | Only after all gates pass and artifacts are on disk: writes the `DONE.json` completion marker and appends the timestamped run to `.sdd-runs.json`. A failed build commits nothing. |

## The spec, in two modes

A spec carries the **component/hook API surface** (module, TS signature lines,
the imports the test file needs), coverable `[[rules]]` and `[[edge_cases]]`
with stable ids (`rule_1`, `edge_1`), and optional `[[sequences]]` mermaid
blocks — ordered `user → component → callback/store/router` interaction
contracts with globally-unique `M`-id numbering.

- **Plan mode** — the spec includes hand-written `[[cases]]`. `toTestPlan()`
  builds the plan deterministically. **No LLM, no network, no keys.** See
  [`examples/search_box.plan.toml`](examples/search_box.plan.toml) and its
  compiled suite in [`examples/generated/`](examples/generated/).
- **Request mode** — the spec is loose (rules/edges/sequences, no `[[cases]]`).
  `planFromSpec()` asks a model to fill the `TestPlan` schema via structured
  output. See [`examples/use_debounce.request.toml`](examples/use_debounce.request.toml).

Mode is overridable by `[meta].mode` or the `--toml-mode` flag.

### What a `TestCase` is, in React terms

| Field | Meaning |
|-------|---------|
| `given` | Arrange — render setup, props, mock/store/router setup. One statement per entry. |
| `when` | The **single act** — a `userEvent` interaction or a hook call under `renderHook`/`act`. Its value is bound to `result`. `"None"` for a pure render assertion. |
| `then` | **Complete RTL assertion statements**, e.g. `expect(screen.getByRole('button')).toBeDisabled()`. Written verbatim into the test — no `assert` wrapper. |
| `covers` | The `M`/`rule_`/`edge_` ids this case exercises. Required when the feature has sequences/rules/edges. |
| `fixtures`, `isAsync`, `edgeCase`, `notes` | Setup helpers, async marker, derived-case flag, one-line context. |

The Zod **field descriptions are the prompt** — they reach the model as
JSON-schema instructions, exactly as the Pydantic `Field(description=...)` do in
Python.

## Requirements

This CLI **only emits test source as strings** — it never imports React or a
test runner, so it stays tiny (`@babel/parser`, `smol-toml`, `zod`). The
generated `.test.tsx` files run in **your app's** existing test harness, which
must already provide the runner and the RTL stack.

The default (Jest) output expects the consuming app to have:

- `jest`, `ts-jest`, `jest-environment-jsdom`
- `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`
- a setup file (via Jest's `setupFilesAfterEnv`) that registers the jest-dom matchers

Most React + TypeScript projects with an existing RTL setup already have these.
If yours doesn't, install them in the **consuming app** (not in this framework):

```bash
# in the CONSUMING app, if not already present:
npm i -D jest ts-jest jest-environment-jsdom \
        @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

The emitted suite assumes Jest's ambient globals (`describe`/`it`/`expect`/
`jest`) and jest-dom matchers from your project setup. If your app uses **Vitest**
instead, pass `{ runner: "vitest" }` to `renderTests` / a render config so the
suite imports `describe/it/expect/vi` from `vitest` — everything else is
identical.

## Usage

```bash
npm install   # framework deps only: @babel/parser, smol-toml, zod

# Plan mode — deterministic, no LLM:
npm run sdd -- examples/search_box.plan.toml --out examples/generated

# Request mode — needs a ChatClient:
npm run sdd -- examples/use_debounce.request.toml --out src/__generated__ \
  --chat-module ./sdd.chat.ts
```

Programmatically:

```ts
import { build } from "reactullm-sdd";

// plan mode
await build("examples/search_box.plan.toml", "src/__generated__");

// request mode (inject any ChatClient — a provider SDK wrapper)
await build("specs/", "src/__generated__", { chat: myChatClient });
```

`build(source, outDir, opts)` orchestrates parse → plan → `scanPlan` (both
modes) → `validatePlan` → render. `strict: true` (default) raises
`PlanValidationError` **after** writing `<slug>.plan.json` for inspection;
`strict: false` lists the problems in the brief instead. A safety violation
always raises `PlanSafetyError` before anything runnable is written — it is
never downgraded to a warning.

## Timestamped runs & the completion marker

Every successful generation is a **run**, stamped with a sortable UTC id
`YYYYMMDDThhmmssZ` (year·month·day·hour·minute·second). Artifacts stay flat in
`<out>/` (stable import paths — no per-run subdirectories), and two bookkeeping
files record the history:

```
out/
  search_box.test.tsx      # artifacts (overwritten each run)
  search_box.plan.json
  BRIEF_search_box.md
  sdd-setup.ts
  DONE.json                # completion marker for the LATEST completed run
  .sdd-runs.json           # append-only history (oldest first)
```

**`DONE.json` is the "we're done" check file.** It is written **only after**
every spec passes the safety and coverage gates *and* every artifact is on disk.
A build that throws (a safety violation, or a strict coverage failure) never
writes it — so a half-finished or failed generation is detectable: the previous
`DONE.json` stays put and remains the resolved latest.

```jsonc
// DONE.json
{
  "runId": "20260711T143005Z",
  "completedAt": "2026-07-11T14:30:05.767Z",
  "tool": "react-sdd@0.1.0",
  "specs": [
    { "feature": "Search box", "slug": "search_box", "mode": "plan",
      "caseCount": 4, "files": ["search_box.test.tsx", "..."],
      "coveredScenarios": ["..."], "coveredIds": ["rule_1", "M1", "..."] }
  ]
}
```

**Continuing with the latest.** On the next generation the CLI prints which
completed run you're building on top of, then commits a new one:

```bash
react-sdd specs/ --out out
# Latest completed run in out: 20260711T143005Z (1 spec(s): search_box)
# ...
# ✓ Run 20260711T150210Z committed (DONE.json updated).

react-sdd --list-runs --out out    # print the full history, newest resolved last
```

Programmatically, resolve the latest completed run yourself:

```ts
import { latestRun, readManifest } from "reactullm-sdd";

const latest = latestRun("out");        // newest RunRecord with a DONE marker, or null
const history = readManifest("out").runs; // full append-only log
```

Ids are second-granularity, so two generations in the same second (or a clock
that steps backwards) are automatically **de-collided** — the second gets a
sortable `.NNN` suffix (`...Z.002`) so "latest" is always unambiguous. Runs are
**not** cross-checked against each other: each is validated only against its own
spec. The run log records *when* and *what* was generated; it does not gate on
history. For reproducible/testable builds, inject the clock or the id:
`build(src, out, { now: () => new Date(...) })` or `{ runId: "20260711T150210Z" }`.

## The procedural security boundary

`scanPlan` is **defense-in-depth, not a sandbox.** A case's `given`/`when`/`then`
and fixture bodies render verbatim into an executable test module, so a hostile
`.toml` is arbitrary code execution — **including in plan mode, where no LLM is
involved.** The AST gate reliably catches accidents and low-effort payloads and
is far harder to fool than a substring scan, but a determined attacker can
construct code that evades any static denylist.

**The real boundary is procedural:**

1. **Spec provenance.** A spec's text reaches the request-mode planner prompt,
   so an untrusted `.toml` is a **prompt-injection vector**. Review where a spec
   came from before generating from it.
2. **Human review before execution.** The rendered suite is arbitrary code. A
   human reviews the diff before it runs anywhere with secrets or network
   access. Run generation/execution of untrusted specs in a sandbox.

Do not weaken the gate or the coverage checks to make a test pass. The point of
the pipeline is that these are load-bearing.

## Why "compile", not "generate"

Review the **plan and tests before** pointing an implementer at the brief. Once
the suite is treated as the spec, a misread scenario is locked in. The suite and
brief are artifacts *compiled* from the spec — re-running the compiler on an
edited spec produces a clean diff, because everything on disk came from a
template, not from model free-text.

## Development

```bash
npm run typecheck   # strict TS, no `any`, ESM
npm test            # the framework's own suite (test/sdd.test.ts)
npm run build       # emit dist/
```

The framework's own tests (38 of them) prove the invariants: the coverage gate
rejects an uncovered id, the safety gate rejects an import (and
`require`/`eval`/`Function`/dynamic `import()`/`process`/reflection/non-TS), plan
mode runs with no network, request mode fills the schema (via an in-memory
`FakeChat` — no keys), and each run writes its `DONE.json` marker only on success
(same-second runs de-collide). These
run under Vitest purely as the framework's *own* dev-time choice — unrelated to
the **Jest** suites the framework *emits* for a consuming app. The emitted-suite
alignment is verified separately: dropping a generated suite into a real React +
TypeScript app and running its `jest` yields the expected red tests, each
failing at its `bddPending()` marker.
