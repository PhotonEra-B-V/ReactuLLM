# Changelog

All notable changes to `reactullm-sdd` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-15

Initial public release.

### Added

- TOML spec front-end: a single spec compiles to a red Vitest/Jest + React
  Testing Library suite plus an implementation brief for an implementing agent.
- **Plan mode** (`[[cases]]` hand-written, no model needed) and **request mode**
  (a structured-output call fills the typed `TestPlan` schema).
- AST safety gate (`safety.ts`) rejecting imports/eval/reflection in plans.
- Mechanical coverage cross-checks (`checks.ts`) — completeness is proven in
  plain code, never by asking the model.
- Deterministic template renderer (`renderer.ts`); the LLM never writes test
  source as free text.
- Mermaid `[[sequences]]` blocks compiled to ordered interaction contracts.
- Cross-stack handoff contract (bidirectional API surface with pyllum/FastAPI).
- Run artifacts (`DONE.json`, manifest, run log) with sortable run ids.
- `react-sdd` CLI and a programmatic `build()` API.

[Unreleased]: https://github.com/PhotonEra-B-V/ReactuLLM/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PhotonEra-B-V/ReactuLLM/releases/tag/v0.1.0
