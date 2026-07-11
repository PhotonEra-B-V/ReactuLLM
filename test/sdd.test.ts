/**
 * The SDD framework's own test suite — a faithful twin of Python's
 * `tests/test_bdd.py`. Proves the invariants: the coverage gate rejects an
 * uncovered id, the safety gate rejects an import (and more), plan mode runs
 * with no network, and request mode fills the schema.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parse as babelParse } from "@babel/parser";

import {
  build,
  latestRun,
  parse,
  parseFile,
  parseSequence,
  PlanSafetyError,
  PlanValidationError,
  planFromSpec,
  readDone,
  readManifest,
  renderTests,
  scanPlan,
  type TestPlan,
  TestPlanSchema,
  toAnnotated,
  toRunId,
  tomlSpec,
  uniqueRunId,
  validatePlan,
} from "../src/index.js";
import { FakeChat, samplePlan } from "./fixtures.js";

function compiles(source: string): void {
  // The renderer's analogue of Python's compile(): the emitted suite must be
  // valid TypeScript/JSX.
  babelParse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sdd-"));
}

const MERMAID = `sequenceDiagram
    participant Client
    Client->>+Server: GET /users
    Server->>+Database: Query Users
    Database-->>-Server: Return Data
    alt service unavailable
        Server-->>Client: 503 Unavailable
    end
    Server-->>-Client: 200 OK
`;

// A complete plan-mode spec: hand-written [[cases]], so NO LLM is consulted.
const PLAN_TOML = `
[meta]
feature_name = "Toggle"
description = "A button that flips a boolean and reports it."
async_required = true

[api]
module = "@/components/Toggle"
imports = ["import { Toggle } from '@/components/Toggle'"]
signatures = ["export function Toggle(props: { onChange: (on: boolean) => void }): JSX.Element"]

[[rules]]
id = "rule_1"
text = "Clicking the button reports the new state."

[[edge_cases]]
id = "edge_1"
text = "Two clicks return to the original state."

[[fixtures]]
name = "makeProps"
body = ["return { onChange: jest.fn<(on: boolean) => void>() };"]

[[cases]]
test_name = "reports true on first click"
scenario = "First click"
given = ["const props = makeProps();", "render(<Toggle {...props} />);"]
when = "await userEvent.click(screen.getByRole('button'))"
then = ["expect(props.onChange).toHaveBeenCalledWith(true)"]
fixtures = ["makeProps"]
covers = ["rule_1"]
is_async = true

[[cases]]
test_name = "returns to original after two clicks"
scenario = "Two clicks"
given = ["const props = makeProps();", "render(<Toggle {...props} />);", "const btn = screen.getByRole('button');"]
when = "await userEvent.click(btn)"
then = ["await userEvent.click(btn)", "expect(props.onChange).toHaveBeenLastCalledWith(false)"]
fixtures = ["makeProps"]
covers = ["edge_1"]
is_async = true
edge_case = true
`;

// A loose request-mode spec: rules/edge_cases only, NO [[cases]] -> planner LLM.
const REQUEST_TOML = `
[meta]
feature_name = "Use debounce"
description = "A debounced value hook."

[api]
module = "@/hooks/useDebounce"
signatures = ["export function useDebounce<T>(value: T, delayMs: number): T"]

[[rules]]
id = "rule_1"
text = "Returns the initial value on first render."

[[edge_cases]]
id = "edge_1"
text = "A change within the window is superseded."
`;

// A spec that ABSORBS mermaid via [[sequences]].
const SEQUENCE_TOML = `
[meta]
feature_name = "User listing"

[api]
module = "@/components/UserList"
signatures = ["export function UserList(props: { client: unknown; db: unknown }): JSX.Element"]

[[cases]]
test_name = "lists users"
scenario = "Listing users"
given = ["render(<UserList client={{}} db={{}} />);"]
when = "None"
then = ["expect(screen.queryAllByRole('listitem')).toHaveLength(0)"]
covers = ["M1"]

[[sequences]]
mermaid = """
${MERMAID}"""
`;

// --- sequence diagrams -------------------------------------------------------
describe("sequence", () => {
  it("parses a mermaid sequence diagram", () => {
    const diagram = parseSequence(MERMAID);
    expect(diagram.participants).toEqual(["Client", "Server", "Database"]);
    expect(diagram.messages.map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
    expect(diagram.messages[0]!.sender).toBe("Client");
    expect(diagram.messages[0]!.receiver).toBe("Server");
    expect(diagram.messages[0]!.text).toBe("GET /users");
    expect(diagram.messages[0]!.kind).toBe("call");
    expect(diagram.messages[2]!.kind).toBe("reply");
    expect(diagram.messages[3]!.context).toEqual(["alt service unavailable"]);
    expect(diagram.messages[4]!.context).toEqual([]);
    expect(toAnnotated(diagram)).toContain("M2: Server -[call]-> Database: Query Users");
  });

  it("requires a sequenceDiagram header", () => {
    expect(() => parseSequence("Client->>Server: hi\n")).toThrow();
  });
});

// --- renderer ----------------------------------------------------------------
describe("renderer", () => {
  it("renders a valid, red Jest + RTL suite (ambient globals, no runner import)", () => {
    const source = renderTests(parse(PLAN_TOML).toTestPlan());
    compiles(source);
    // Jest: describe/it/expect/jest are ambient — the suite must NOT import them.
    expect(source).not.toContain('from "vitest"');
    expect(source).not.toContain("from 'vitest'");
    expect(source).toContain('import { render, screen, renderHook, act, waitFor } from "@testing-library/react";');
    expect(source).toContain('import userEvent from "@testing-library/user-event";');
    expect(source).toContain('import { bddPending } from "./sdd-setup";');
    expect(source).toContain("import { Toggle } from '@/components/Toggle'");
    expect(source).toContain('describe("Toggle", () => {');
    expect(source).toContain('it("reports true on first click", async () => {');
    expect(source).toContain("bddPending(); // TODO: delete this line when the test passes");
    expect(source).toContain("const result = await userEvent.click(screen.getByRole('button'));");
    expect(source).toContain("expect(props.onChange).toHaveBeenCalledWith(true);");
    expect(source).toContain("// Edge case derived from: Two clicks");
  });

  it("can target Vitest when configured", () => {
    const source = renderTests(parse(PLAN_TOML).toTestPlan(), {
      runner: "vitest",
      setupModule: "./sdd-setup",
    });
    compiles(source);
    expect(source).toContain('import { describe, it, expect, vi } from "vitest";');
  });

  it("sanitizes and dedupes fixture names", () => {
    const plan = parse(PLAN_TOML).toTestPlan();
    plan.fixtures.push({ name: "make props!", body: ["return {};"] });
    plan.fixtures.push({ name: "make props!", body: ["return {};"] });
    const source = renderTests(plan);
    compiles(source);
    // "make props!" sanitizes to make_props; the second collides and dedupes.
    expect(source).toContain("function make_props(");
    expect(source).toContain("function make_props_2(");
  });

  it("emits a covers comment", () => {
    const plan = parse(PLAN_TOML).toTestPlan();
    plan.cases[0]!.covers = ["M1", "M4"];
    const source = renderTests(plan);
    compiles(source);
    expect(source).toContain("// Covers: M1, M4");
  });
});

// --- toml front-end ----------------------------------------------------------
describe("toml front-end", () => {
  it("parses meta/api and derives slug + mode", () => {
    const spec = parse(PLAN_TOML);
    expect(spec.meta.featureName).toBe("Toggle");
    expect(spec.meta.description).toContain("flips a boolean");
    expect(spec.slug).toBe("toggle");
    expect(spec.api.module).toBe("@/components/Toggle");
  });

  it("requires a feature name", () => {
    expect(() => parse('[api]\nmodule = "x"\n')).toThrow();
  });

  it("plan mode round-trips to valid tsx with no chat", async () => {
    const spec = parse(PLAN_TOML);
    expect(spec.mode).toBe("plan");

    const plan = spec.toTestPlan();
    expect(plan.feature).toBe("Toggle");
    expect(new Set(plan.cases.map((c) => c.testName))).toEqual(
      new Set(["reports true on first click", "returns to original after two clicks"]),
    );

    const source = renderTests(plan);
    compiles(source);
    // No chat client is even available in plan mode.
    const out = tmp();
    const results = await build(PLAN_TOML, out); // no { chat }
    expect(results).toHaveLength(1);
  });

  it("request mode dispatches to the planner (schema filled)", async () => {
    const chat = new FakeChat(samplePlan());
    const spec = parse(REQUEST_TOML);
    expect(spec.mode).toBe("request");
    expect(spec.toPrompt()).toBeTruthy();

    const result = await planFromSpec(spec, { chat });
    expect(TestPlanSchema.parse(result).api.module).toBe("@/hooks/useDebounce");
    expect(chat.prompts).toHaveLength(1); // the planner was actually called
    expect(chat.instructions).toContain("React test architect");
  });

  it("auto-detects mode from [[cases]]", () => {
    expect(parse(PLAN_TOML).mode).toBe("plan");
    expect(parse(REQUEST_TOML).mode).toBe("request");
  });

  it("lets [meta].mode override auto-detect", () => {
    const forced = PLAN_TOML.replace("[meta]\n", '[meta]\nmode = "request"\n');
    expect(parse(forced).mode).toBe("request");
  });

  it("absorbs mermaid [[sequences]] into M-ids", () => {
    const spec = parse(SEQUENCE_TOML);
    expect(spec.sequences).toHaveLength(1);
    expect(spec.sequences[0]!.messages.map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
    expect(spec.messageIds()).toEqual(new Set(["M1", "M2", "M3", "M4", "M5"]));
  });

  it("parseFile reads the same spec off disk", () => {
    const dir = tmp();
    const path = join(dir, "toggle.toml");
    writeFileSync(path, PLAN_TOML);
    const spec = parseFile(path);
    expect(spec.mode).toBe("plan");
    expect(spec.slug).toBe("toggle");
  });

  it("exports the tomlSpec module", () => {
    expect(tomlSpec.parse).toBe(parse);
    expect(tomlSpec.parseFile).toBe(parseFile);
  });
});

// --- THE coverage guarantee (validate_plan) ----------------------------------
describe("coverage gate", () => {
  it("flags an uncovered rule", () => {
    const spec = parse(PLAN_TOML);
    const plan = spec.toTestPlan();
    // drop the case that covers rule_1 -> rule_1 is now uncovered
    plan.cases = plan.cases.filter((c) => !c.covers.includes("rule_1"));

    const problems = validatePlanFor(spec, plan);
    expect(problems.some((p) => p.includes("rule_1"))).toBe(true);
  });

  it("flags uncovered scenarios, unknown ids, and uncovered messages", () => {
    const spec = parse(SEQUENCE_TOML);
    const plan = spec.toTestPlan();
    plan.cases[0]!.covers = ["M1", "M99"]; // claim an id that doesn't exist
    const problems = validatePlan(plan, {
      scenarioNames: new Set([...spec.scenarioNames(), "Listing users elsewhere"]),
      messageIds: spec.messageIds(),
      requiredIds: spec.requiredIds(),
    });
    expect(problems.some((p) => p.includes("Listing users elsewhere"))).toBe(true); // scenario
    expect(problems.some((p) => p.includes('"M99"'))).toBe(true); // unknown id
    expect(problems.some((p) => p.includes("M2"))).toBe(true); // uncovered message

    // a sound plan for the plan-mode spec has no problems
    const good = parse(PLAN_TOML);
    expect(validatePlanFor(good, good.toTestPlan())).toEqual([]);
  });
});

// --- build orchestration -----------------------------------------------------
describe("build", () => {
  it("request-mode build writes suite, plan, and brief", async () => {
    const dir = tmp();
    const specFile = join(dir, "debounce.toml");
    writeFileSync(specFile, REQUEST_TOML);
    const out = join(dir, "generated");
    const chat = new FakeChat(samplePlan());

    // samplePlan covers no rule/edge, so run lenient to still write files.
    const results = await build(specFile, out, { chat, strict: false });
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.testPath).toBe(join(out, "use_debounce.test.tsx"));
    compiles(readFileSync(result.testPath, "utf-8"));

    const saved = JSON.parse(readFileSync(result.planPath, "utf-8")) as TestPlan;
    expect(TestPlanSchema.parse(saved)).toEqual(result.plan);

    const brief = readFileSync(result.briefPath, "utf-8");
    expect(brief).toContain("useDebounce<T>(value: T, delayMs: number): T");
    expect(brief).toContain("read-only");
    const setup = readFileSync(join(out, "sdd-setup.ts"), "utf-8");
    expect(setup).toContain("bddPending");
    expect(setup).toContain("renderWithProviders");
  });

  it("strict rejects an uncovered rule, writes plan.json, withholds the test", async () => {
    const dir = tmp();
    const specFile = join(dir, "debounce.toml");
    writeFileSync(specFile, REQUEST_TOML);
    const out = join(dir, "generated");
    const chat = new FakeChat(samplePlan()); // covers no rule/edge ids

    await expect(build(specFile, out, { chat })).rejects.toBeInstanceOf(PlanValidationError);
    expect(existsSync(join(out, "use_debounce.plan.json"))).toBe(true);
    expect(existsSync(join(out, "use_debounce.test.tsx"))).toBe(false);
  });

  it("lenient records validation warnings and the collaboration contract", async () => {
    const dir = tmp();
    const requestSequence = `
[meta]
feature_name = "User listing"

[api]
module = "@/components/UserList"
signatures = ["export function UserList(props: { client: unknown; db: unknown }): JSX.Element"]

[[sequences]]
mermaid = """
${MERMAID}"""
`;
    const specFile = join(dir, "users.toml");
    writeFileSync(specFile, requestSequence);
    const out = join(dir, "generated");
    const chat = new FakeChat(samplePlan()); // covers none of the M-ids

    const results = await build(specFile, out, { chat, strict: false });
    expect(results[0]!.feature.sequences).toHaveLength(1);
    const brief = readFileSync(results[0]!.briefPath, "utf-8");
    expect(brief).toContain("Plan validation warnings");
    expect(brief).toContain("```mermaid");
    expect(brief).toContain("Message traceability");
    expect(brief).toContain("**uncovered**");
  });
});

// --- safety gate -------------------------------------------------------------
function planWith(overrides: Partial<TestPlan["cases"][number]>): TestPlan {
  return {
    feature: "F",
    api: { module: "m", imports: [], signatures: ["export function f(): number"] },
    fixtures: [],
    cases: [
      {
        scenario: "s",
        testName: "case x",
        given: [],
        when: "f()",
        then: ["expect(result).toBe(1)"],
        fixtures: [],
        covers: [],
        isAsync: false,
        edgeCase: false,
        notes: "",
        ...overrides,
      },
    ],
    requiredIds: [],
  };
}

describe("safety gate", () => {
  it("passes a benign plan-mode sample", () => {
    expect(scanPlan(parse(PLAN_TOML).toTestPlan())).toEqual([]);
  });

  it("flags an import statement in given", () => {
    const problems = scanPlan(planWith({ given: ["import fs from 'fs'"], when: "None", then: [] }));
    expect(problems.some((p) => p.includes("import statement"))).toBe(true);
  });

  it("flags require()", () => {
    const problems = scanPlan(planWith({ when: "require('child_process').execSync('id')" }));
    expect(problems.some((p) => p.includes("require"))).toBe(true);
  });

  it("flags eval / Function", () => {
    expect(scanPlan(planWith({ when: "eval('1+1')" })).some((p) => p.includes("eval"))).toBe(true);
    expect(
      scanPlan(planWith({ when: "new Function('return 1')()" })).some((p) => p.includes("Function")),
    ).toBe(true);
  });

  it("flags process/globalThis/window exfiltration", () => {
    expect(scanPlan(planWith({ when: "process.env.SECRET" })).some((p) => p.includes("process"))).toBe(true);
    expect(
      scanPlan(planWith({ when: "globalThis.fetch('http://x')" })).some((p) => p.includes("globalThis")),
    ).toBe(true);
    expect(scanPlan(planWith({ when: "window.location.href" })).some((p) => p.includes("window"))).toBe(true);
  });

  it("flags dynamic import()", () => {
    const problems = scanPlan(planWith({ when: "import('node:fs')" }));
    expect(problems.some((p) => p.includes("dynamic import"))).toBe(true);
  });

  it("flags reflection via constructor/__proto__", () => {
    const problems = scanPlan(planWith({ when: "({}).constructor.constructor('return 1')()" }));
    expect(problems.some((p) => p.includes("reflection"))).toBe(true);
  });

  it("flags non-parseable input", () => {
    const problems = scanPlan(planWith({ when: "this is not typescript !!!" }));
    expect(problems.some((p) => p.includes("not valid"))).toBe(true);
  });

  it("flags a fixture body", () => {
    const plan = planWith({});
    plan.fixtures = [{ name: "evil", body: ["const net = require('net');", "return net;"] }];
    expect(scanPlan(plan).some((p) => p.includes('fixture "evil"'))).toBe(true);
  });

  it("build blocks a hostile plan-mode spec and writes nothing runnable (no LLM)", async () => {
    const dir = tmp();
    const hostile = `
[meta]
feature_name = "Evil"
[api]
module = "m"
signatures = ["export function f(): number"]
[[cases]]
test_name = "pwn"
scenario = "pwn"
when = "require('child_process').execSync('id')"
then = ["expect(result).toBe(1)"]
`;
    const specFile = join(dir, "evil.toml");
    writeFileSync(specFile, hostile);
    const out = join(dir, "generated");

    await expect(build(specFile, out)).rejects.toBeInstanceOf(PlanSafetyError); // no chat needed: plan mode
    expect(existsSync(join(out, "evil.plan.json"))).toBe(true); // kept for inspection
    expect(existsSync(join(out, "evil.test.tsx"))).toBe(false); // nothing runnable written
  });
});

// helper: run the coverage gate against a spec's own coverage sets.
function validatePlanFor(spec: ReturnType<typeof parse>, plan: TestPlan): string[] {
  return validatePlan(plan, {
    scenarioNames: spec.scenarioNames(),
    messageIds: spec.messageIds(),
    requiredIds: spec.requiredIds(),
  });
}

// --- timestamped runs: completion marker + history ---------------------------
describe("run tracking", () => {
  it("formats a sortable UTC run id", () => {
    const id = toRunId(new Date(Date.UTC(2026, 6, 11, 9, 5, 3)));
    expect(id).toBe("20260711T090503Z");
  });

  it("writes DONE.json + manifest only after a successful build", async () => {
    const out = join(tmp(), "generated");
    const results = await build(PLAN_TOML, out, { runId: "20260711T120000Z" });

    expect(results[0]!.runId).toBe("20260711T120000Z");
    const done = readDone(out);
    expect(done).not.toBeNull();
    expect(done!.runId).toBe("20260711T120000Z");
    expect(done!.tool).toContain("react-sdd@");
    expect(done!.specs[0]!.slug).toBe("toggle");
    expect(done!.specs[0]!.files).toContain("toggle.test.tsx");
    // coverage sets recorded for the record (not cross-checked)
    expect(done!.specs[0]!.coveredIds).toContain("rule_1");

    expect(readManifest(out).runs).toHaveLength(1);
    expect(latestRun(out)!.runId).toBe("20260711T120000Z");
  });

  it("appends each run and resolves the newest as latest", async () => {
    const out = join(tmp(), "generated");
    await build(PLAN_TOML, out, { runId: "20260711T120000Z" });
    await build(PLAN_TOML, out, { runId: "20260711T130000Z" });
    await build(PLAN_TOML, out, { runId: "20260711T140000Z" });

    const runs = readManifest(out).runs;
    expect(runs.map((r) => r.runId)).toEqual([
      "20260711T120000Z",
      "20260711T130000Z",
      "20260711T140000Z",
    ]);
    expect(latestRun(out)!.runId).toBe("20260711T140000Z");
    expect(readDone(out)!.runId).toBe("20260711T140000Z");
  });

  it("derives a run id from the injected clock", async () => {
    const out = join(tmp(), "generated");
    await build(PLAN_TOML, out, { now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) });
    expect(latestRun(out)!.runId).toBe("20260102T030405Z");
  });

  it("does NOT commit a run when the build fails a gate (latest stays put)", async () => {
    const out = join(tmp(), "generated");
    // First, a good committed run.
    await build(PLAN_TOML, out, { runId: "20260711T120000Z" });

    // Then a hostile spec that trips the safety gate — must not advance latest.
    const hostile = `
[meta]
feature_name = "Evil"
[api]
module = "m"
signatures = ["export function f(): number"]
[[cases]]
test_name = "pwn"
scenario = "pwn"
when = "require('child_process').execSync('id')"
then = ["expect(result).toBe(1)"]
`;
    await expect(
      build(hostile, out, { runId: "20260711T130000Z" }),
    ).rejects.toBeInstanceOf(PlanSafetyError);

    // The failed run left no DONE.json / manifest entry; latest is unchanged.
    expect(readDone(out)!.runId).toBe("20260711T120000Z");
    expect(readManifest(out).runs.map((r) => r.runId)).toEqual(["20260711T120000Z"]);
    expect(latestRun(out)!.runId).toBe("20260711T120000Z");
  });

  it("latestRun is null for a directory with no completed run", () => {
    expect(latestRun(tmp())).toBeNull();
  });

  it("de-collides same-second run ids so ordering stays total", () => {
    expect(uniqueRunId("20260711T120000Z", [])).toBe("20260711T120000Z");
    // same second as the newest -> gets a sortable .NNN disambiguator
    expect(uniqueRunId("20260711T120000Z", ["20260711T120000Z"])).toBe("20260711T120000Z.002");
    expect(
      uniqueRunId("20260711T120000Z", ["20260711T120000Z", "20260711T120000Z.002"]),
    ).toBe("20260711T120000Z.003");
    // an id that doesn't sort after history is disambiguated OFF the newest id,
    // so the result is guaranteed to exceed it (a suffix on the older prefix
    // never could) — keeping the sequence a total order.
    expect(uniqueRunId("20260711T110000Z", ["20260711T120000Z"])).toBe("20260711T120000Z.002");
  });

  it("two builds in the same second both commit, uniquely ordered", async () => {
    const out = join(tmp(), "generated");
    const clock = () => new Date(Date.UTC(2026, 6, 11, 12, 0, 0)); // frozen to one second
    const a = await build(PLAN_TOML, out, { now: clock });
    const b = await build(PLAN_TOML, out, { now: clock });

    expect(a[0]!.runId).toBe("20260711T120000Z");
    expect(b[0]!.runId).toBe("20260711T120000Z.002"); // de-collided
    expect(readManifest(out).runs).toHaveLength(2);
    expect(latestRun(out)!.runId).toBe("20260711T120000Z.002");
  });
});

