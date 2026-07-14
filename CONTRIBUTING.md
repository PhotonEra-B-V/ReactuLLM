# Contributing to reactullm-sdd

Thanks for your interest in improving reactullm-sdd.

## Install

This repo is the **framework** — it only emits test *source as strings* and never
imports React or a test runner itself. Installing its dev dependencies is enough
to develop and run the test suite:

```bash
npm install   # framework deps only: @babel/parser, smol-toml, zod (+ dev tooling)
```

You do **not** install Jest/Vitest or `@testing-library/*` here. Those are
[`peerDependencies`](package.json) declared as documentation — the *consuming
app* supplies them for the suites this tool generates.

## Develop

```bash
npm run sdd            # run the CLI (tsx src/cli.ts)
npm run gen:contract   # regenerate reactullm-pyllum.contract.json
npm run build          # tsc -> dist/
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run test:watch     # vitest watch
```

## Before opening a PR

Run the same checks CI does — all three must pass:

```bash
npm run typecheck && npm test && npm run build
```

## The one invariant (do not break)

> The LLM never writes test code as free text. It only fills a typed schema.
> Test source is always rendered from templates. Coverage completeness is proven
> by mechanical cross-checks in plain code — never by asking the model whether it
> covered everything.

Keep the AST safety gate (`src/safety.ts`) and the mechanical coverage checks
(`src/checks.ts`) authoritative: a failed gate must commit nothing. Any change
that touches the pipeline should preserve this.

## Changelog

Note user-facing changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
