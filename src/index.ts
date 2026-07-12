/**
 * SDD builder: turn a TOML spec into a red Vitest + React Testing Library suite
 * that serves as the building instruction for an implementing agent.
 *
 * TOML is the single spec front-end. It carries the component/hook API surface,
 * coverable rules and edge cases, optional mermaid `[[sequences]]` blocks
 * (parsed by {@link module:sequence}) describing ordered user → component →
 * callback/store/router interaction contracts, and — in *plan mode* —
 * hand-written `[[cases]]`.
 *
 * Pipeline: parse ({@link module:tomlSpec}) -> plan (deterministic
 * `toTestPlan` in plan mode, or a structured-output call via
 * {@link module:planner} in request mode) -> deterministic rendering
 * ({@link module:renderer}) plus an implementation brief
 * ({@link module:brief}):
 *
 * ```ts
 * import { build } from "reactullm-sdd";
 * const results = await build("specs/", "src/__generated__", { chat });
 * ```
 *
 * Or from the shell:
 *
 * ```
 * react-sdd specs/ --out src/__generated__
 * ```
 *
 * The LLM only ever fills the {@link TestPlanSchema} schema; test code is
 * rendered from templates, so plans are reviewable and re-runs diff cleanly.
 * Review the plan and generated tests *before* implementation — the suite is
 * treated as the specification from then on.
 *
 * A structural twin of Python's `pyllm.bdd`: same philosophy (one TOML spec is
 * the source of truth), same guarantees (mechanical coverage + AST safety
 * gates), adapted to the React/TypeScript world.
 */

export type { ChatClient, ChatMessage } from "./chat.js";
export { validatePlan } from "./checks.js";
export {
  build,
  type BuildOptions,
  type BuildResult,
  PlanSafetyError,
  PlanValidationError,
  TOOL,
  type TomlMode,
} from "./builder.js";
export { planFromSpec, SPEC_PLANNER_INSTRUCTIONS } from "./planner.js";
export {
  commitRun,
  DONE_FILENAME,
  latestRun,
  MANIFEST_FILENAME,
  type Manifest,
  readDone,
  readManifest,
  type RunRecord,
  type RunSpecEntry,
  toRunId,
  uniqueRunId,
} from "./runs.js";
export { DEFAULT_RENDER_CONFIG, type RenderConfig, renderSetup, renderTests } from "./renderer.js";
export { scanPlan } from "./safety.js";
export {
  type ApiSurface,
  ApiSurfaceSchema,
  type FixtureDef,
  FixtureDefSchema,
  type TestCase,
  TestCaseSchema,
  type TestPlan,
  TestPlanSchema,
} from "./schema.js";
export {
  type MessageKind,
  parse as parseSequence,
  type SequenceDiagram,
  type SequenceMessage,
  toAnnotated,
} from "./sequence.js";
export * as tomlSpec from "./tomlSpec.js";
export {
  type Api,
  type Case,
  type Coverable,
  type Fixture,
  type Meta,
  type Mode,
  parse,
  parseFile,
  TomlSpec,
} from "./tomlSpec.js";
