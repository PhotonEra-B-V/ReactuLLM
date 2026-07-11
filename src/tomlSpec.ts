/**
 * TOML front-end for the SDD builder — one spec file, two modes.
 *
 * A TOML spec is the single authoring surface for React SDD: the API surface
 * (component/hook module, prop/type signature lines, the import statements the
 * test file needs), coverable rules and edge cases, optional `sequenceDiagram`
 * blocks (parsed by {@link module:sequence}) describing ordered user →
 * component → callback/store/router interaction contracts, and — in *plan
 * mode* — hand-written test cases.
 *
 * Two modes, auto-detected from the presence of `[[cases]]` unless
 * `[meta].mode` says otherwise:
 *
 * - **plan mode** — the spec carries `[[cases]]`; {@link TomlSpec.toTestPlan}
 *   builds a {@link TestPlan} deterministically, with no LLM in the loop. The
 *   plan is rendered by `renderTests` and accepted by `validatePlan` when the
 *   cases cover every rule/edge/message id.
 * - **request mode** — the spec is loose (rules and edge cases, no cases);
 *   {@link TomlSpec.toPrompt} produces a prompt block for the planner LLM,
 *   which fills the `TestPlan` schema. The watertight guarantee still lives in
 *   `validatePlan` + template rendering; the model never writes test text.
 *
 * Value objects are frozen with `toDict()`, a `slug` getter, and
 * globally-unique `M`-id numbering across every `[[sequences]]` block via the
 * `start` arg to `sequence.parse`. A faithful twin of `pyllm.bdd.toml_spec`.
 */

import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

import type { ApiSurface, FixtureDef, TestCase, TestPlan } from "./schema.js";
import { parse as parseSequence, type SequenceDiagram, toAnnotated } from "./sequence.js";

export type Mode = "plan" | "request";

export interface Meta {
  readonly featureName: string;
  readonly description: string;
  readonly mode: Mode | null;
  readonly asyncRequired: boolean;
}

export interface Api {
  readonly module: string;
  readonly imports: readonly string[];
  readonly signatures: readonly string[];
}

/** A rule or edge case carrying a coverable id (`rule_1`, `edge_1`). */
export interface Coverable {
  readonly id: string;
  readonly text: string;
}

/** A hand-written test case (plan mode); mirrors `schema.TestCase`. */
export interface Case {
  readonly testName: string;
  readonly scenario: string;
  readonly given: readonly string[];
  readonly when: string;
  readonly then: readonly string[];
  readonly fixtures: readonly string[];
  readonly covers: readonly string[];
  readonly isAsync: boolean;
  readonly edgeCase: boolean;
  readonly notes: string;
}

/** A hand-written fixture (plan mode); mirrors `schema.FixtureDef`. */
export interface Fixture {
  readonly name: string;
  readonly body: readonly string[];
}

function apiToSurface(api: Api): ApiSurface {
  return {
    module: api.module,
    imports: [...api.imports],
    signatures: [...api.signatures],
  };
}

function caseToTestCase(c: Case): TestCase {
  return {
    scenario: c.scenario,
    testName: c.testName,
    given: [...c.given],
    when: c.when,
    then: [...c.then],
    fixtures: [...c.fixtures],
    covers: [...c.covers],
    isAsync: c.isAsync,
    edgeCase: c.edgeCase,
    notes: c.notes,
  };
}

function fixtureToDef(f: Fixture): FixtureDef {
  return { name: f.name, body: [...f.body] };
}

export class TomlSpec {
  constructor(
    readonly meta: Meta,
    readonly api: Api,
    readonly rules: readonly Coverable[],
    readonly edgeCases: readonly Coverable[],
    readonly sequences: readonly SequenceDiagram[],
    readonly cases: readonly Case[],
    readonly fixtures: readonly Fixture[],
    readonly sourcePath: string | null = null,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      meta: { ...this.meta },
      api: { module: this.api.module, imports: [...this.api.imports], signatures: [...this.api.signatures] },
      rules: this.rules.map((r) => ({ ...r })),
      edgeCases: this.edgeCases.map((e) => ({ ...e })),
      sequences: this.sequences.map((d) => ({
        participants: [...d.participants],
        messages: d.messages.map((m) => ({ ...m, context: [...m.context] })),
        source: d.source,
      })),
      cases: this.cases.map((c) => ({ ...c })),
      fixtures: this.fixtures.map((f) => ({ name: f.name, body: [...f.body] })),
      sourcePath: this.sourcePath,
    };
  }

  // -- identity -----------------------------------------------------------

  /** Filesystem/identifier-safe name: `Search box` -> `search_box`. */
  get slug(): string {
    const slug = this.meta.featureName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return slug || "feature";
  }

  /** Explicit `[meta].mode` wins; else 'plan' iff any `[[cases]]`. */
  get mode(): Mode {
    if (this.meta.mode !== null) return this.meta.mode;
    return this.cases.length ? "plan" : "request";
  }

  // -- coverage sets (feed straight into checks.validatePlan) -------------

  /** Scenario names every plan must cover (from `[[cases]]`). */
  scenarioNames(): Set<string> {
    return new Set(this.cases.map((c) => c.scenario));
  }

  /** Sequence-diagram message ids (`M1`, ...) across all diagrams. */
  messageIds(): Set<string> {
    const ids = new Set<string>();
    for (const d of this.sequences) for (const m of d.messages) ids.add(m.id);
    return ids;
  }

  /** Rule + edge-case ids, folded into one set (the contract's field). */
  requiredIds(): Set<string> {
    const ids = new Set<string>();
    for (const r of this.rules) ids.add(r.id);
    for (const e of this.edgeCases) ids.add(e.id);
    return ids;
  }

  // -- plan mode ----------------------------------------------------------

  /**
   * Deterministically build a {@link TestPlan} from `[[cases]]`.
   *
   * The resulting plan renders via `renderTests` and is accepted by
   * `validatePlan` when the hand-written cases cover every rule, edge case, and
   * sequence-diagram message id. No LLM is consulted.
   */
  toTestPlan(): TestPlan {
    return {
      feature: this.meta.featureName,
      api: apiToSurface(this.api),
      fixtures: this.fixtures.map(fixtureToDef),
      cases: this.cases.map(caseToTestCase),
      requiredIds: [...this.requiredIds()].sort(),
    };
  }

  // -- request mode -------------------------------------------------------

  /**
   * A readable prompt block for the planner LLM (request mode).
   *
   * Lists the API surface, every rule and edge case with its id, and any
   * sequence diagrams, instructing that every id be claimed via 'covers'.
   */
  toPrompt(): string {
    const lines: string[] = [`Feature: ${this.meta.featureName}`];
    if (this.meta.description) {
      for (const line of this.meta.description.split("\n")) lines.push(`  ${line}`);
    }

    lines.push("");
    lines.push("Component/hook API surface (exercise only this):");
    lines.push(`  module: ${this.api.module}`);
    for (const imp of this.api.imports) lines.push(`  import: ${imp}`);
    for (const sig of this.api.signatures) lines.push(`  signature: ${sig}`);

    if (this.rules.length) {
      lines.push("");
      lines.push("Rules (cover every id via 'covers'):");
      for (const r of this.rules) lines.push(`  ${r.id}: ${r.text}`);
    }

    if (this.edgeCases.length) {
      lines.push("");
      lines.push("Edge cases (cover every id via 'covers'):");
      for (const e of this.edgeCases) lines.push(`  ${e.id}: ${e.text}`);
    }

    if (this.sequences.length) {
      lines.push("");
      lines.push("Sequence-diagram messages (cover every id via 'covers'):");
      for (const diagram of this.sequences) lines.push(toAnnotated(diagram));
    }

    if (this.meta.asyncRequired) {
      lines.push("");
      lines.push(
        "This feature is async: set isAsync=true and use 'await' in the act " +
          "(userEvent / findBy* / waitFor).",
      );
    }

    lines.push("");
    lines.push(
      "Every rule id, edge-case id, and sequence message id above MUST be " +
        "claimed by at least one test case via its 'covers' list.",
    );
    return lines.join("\n") + "\n";
  }
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

type TomlTable = Record<string, unknown>;

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

function asTable(value: unknown): TomlTable {
  return value && typeof value === "object" ? (value as TomlTable) : {};
}

function asTableArray(value: unknown): TomlTable[] {
  if (!Array.isArray(value)) return [];
  return value.map(asTable);
}

function coverables(entries: unknown): Coverable[] {
  return asTableArray(entries).map((entry) => ({
    id: String(entry["id"]),
    text: String(entry["text"] ?? ""),
  }));
}

function cases(entries: unknown): Case[] {
  return asTableArray(entries).map((entry) => ({
    testName: String(entry["testName"] ?? entry["test_name"]),
    scenario: String(entry["scenario"] ?? ""),
    given: strArray(entry["given"]),
    when: String(entry["when"] ?? "None"),
    then: strArray(entry["then"]),
    fixtures: strArray(entry["fixtures"]),
    covers: strArray(entry["covers"]),
    isAsync: Boolean(entry["isAsync"] ?? entry["is_async"] ?? false),
    edgeCase: Boolean(entry["edgeCase"] ?? entry["edge_case"] ?? false),
    notes: String(entry["notes"] ?? ""),
  }));
}

function fixtures(entries: unknown): Fixture[] {
  return asTableArray(entries).map((entry) => ({
    name: String(entry["name"]),
    body: strArray(entry["body"]),
  }));
}

/**
 * Parse each `[[sequences]]` mermaid string, keeping ids globally unique.
 *
 * Each diagram starts one past the running message count via the `start` arg
 * to `sequence.parse`, so `M`-ids stay unique across all blocks.
 */
function sequences(entries: unknown): SequenceDiagram[] {
  const diagrams: SequenceDiagram[] = [];
  for (const entry of asTableArray(entries)) {
    const mermaid = String(entry["mermaid"]);
    const nextId = 1 + diagrams.reduce((acc, d) => acc + d.messages.length, 0);
    diagrams.push(parseSequence(mermaid, { start: nextId }));
  }
  return diagrams;
}

/**
 * Parse a TOML spec into a {@link TomlSpec}.
 *
 * Throws when `[meta].feature_name` / `featureName` is missing.
 */
export function parse(text: string, options: { sourcePath?: string } = {}): TomlSpec {
  const data = parseToml(text) as TomlTable;

  const metaRaw = asTable(data["meta"]);
  const featureName = metaRaw["featureName"] ?? metaRaw["feature_name"];
  if (!featureName) {
    throw new Error("TOML spec missing required [meta].feature_name");
  }
  const modeRaw = (metaRaw["mode"] ?? null) as Mode | null;
  if (modeRaw !== null && modeRaw !== "plan" && modeRaw !== "request") {
    throw new Error(`[meta].mode must be 'plan' or 'request', got ${JSON.stringify(modeRaw)}`);
  }
  const meta: Meta = {
    featureName: String(featureName),
    description: String(metaRaw["description"] ?? ""),
    mode: modeRaw,
    asyncRequired: Boolean(metaRaw["asyncRequired"] ?? metaRaw["async_required"] ?? false),
  };

  const apiRaw = asTable(data["api"]);
  const moduleName = apiRaw["module"];
  if (!moduleName) {
    throw new Error("TOML spec missing required [api].module");
  }
  const api: Api = {
    module: String(moduleName),
    imports: strArray(apiRaw["imports"]),
    signatures: strArray(apiRaw["signatures"]),
  };

  return new TomlSpec(
    meta,
    api,
    coverables(data["rules"]),
    coverables(data["edgeCases"] ?? data["edge_cases"]),
    sequences(data["sequences"]),
    cases(data["cases"]),
    fixtures(data["fixtures"]),
    options.sourcePath ?? null,
  );
}

export function parseFile(path: string): TomlSpec {
  return parse(readFileSync(path, "utf-8"), { sourcePath: path });
}
