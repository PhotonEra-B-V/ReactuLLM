/**
 * Orchestrate the pipeline: parse -> plan -> render tests + brief to disk.
 *
 * A faithful twin of `pyllm.bdd.builder`. TOML is the single front-end. A spec
 * with hand-written `[[cases]]` is 'plan' mode (`spec.toTestPlan()` — no LLM);
 * a loose spec with only rules/edge_cases is 'request' mode
 * ({@link planFromSpec} fills the plan via the model). Mode is auto-detected
 * from the presence of `[[cases]]` unless `[meta].mode` (or `tomlMode`) is set.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderBrief } from "./brief.js";
import type { ChatClient } from "./chat.js";
import { validatePlan } from "./checks.js";
import { aliasImports, resolveConfig, type ResolvedConfig } from "./config.js";
import { planFromSpec } from "./planner.js";
import { renderSetup, renderTests } from "./renderer.js";
import { commitRun, type RunSpecEntry, toRunId } from "./runs.js";
import { scanPlan } from "./safety.js";
import type { TestPlan } from "./schema.js";
import { parse as parseToml, parseFile as parseTomlFile, type TomlSpec } from "./tomlSpec.js";

/**
 * The LLM-produced (or hand-written) plan failed the deterministic
 * cross-checks.
 */
export class PlanValidationError extends Error {
  constructor(readonly sourceName: string, readonly problems: string[]) {
    const details = problems.map((p) => `  - ${p}`).join("\n");
    super(
      `plan for ${JSON.stringify(sourceName)} failed validation ` +
        `(the plan JSON was still written for inspection):\n${details}`,
    );
    this.name = "PlanValidationError";
  }
}

/**
 * A plan's executable strings tripped the AST safety gate.
 *
 * Thrown before rendering — regardless of `strict` — so no runnable suite is
 * ever written from a plan containing imports, `require`, `eval`/`Function`,
 * dynamic `import()`, process/globalThis/window reflection, or non-parseable
 * input. Defense-in-depth, not a sandbox (see {@link module:safety}): a human
 * must still review generated tests before running them in a privileged
 * environment.
 */
export class PlanSafetyError extends Error {
  constructor(readonly sourceName: string, readonly problems: string[]) {
    const details = problems.map((p) => `  - ${p}`).join("\n");
    super(
      `plan for ${JSON.stringify(sourceName)} failed the safety gate ` +
        `(nothing runnable was written; the plan JSON was kept for inspection):\n${details}`,
    );
    this.name = "PlanSafetyError";
  }
}

/** Tool id recorded in each run's `DONE.json` / manifest entry. */
export const TOOL = "react-sdd@0.1.0";

export interface BuildResult {
  readonly feature: TomlSpec;
  readonly plan: TestPlan;
  readonly testPath: string;
  readonly planPath: string;
  readonly briefPath: string;
  /** The timestamped run id this artifact belongs to (`YYYYMMDDThhmmssZ`). */
  readonly runId: string;
}

export type TomlMode = "auto" | "plan" | "request";

export interface BuildOptions {
  apiHint?: string | null;
  strict?: boolean;
  tomlMode?: TomlMode;
  /** Required only for request-mode specs; plan mode never touches it. */
  chat?: ChatClient;
  /**
   * Resolved generation config (runner/platform/dependencies) from the target
   * project's `reactullm.config.json`. When omitted, {@link build} resolves it
   * by walking up from `outDir` (see {@link resolveConfig}), so the CLI and
   * library callers get project-local config automatically.
   */
  config?: ResolvedConfig;
  /**
   * Clock for the run id, injectable for deterministic/testable builds.
   * Defaults to the real time when the run starts.
   */
  now?: () => Date;
  /**
   * Override the run id outright (`YYYYMMDDThhmmssZ`). Wins over `now`; mainly
   * for tests and reproducible re-runs.
   */
  runId?: string;
}

function discover(source: string): TomlSpec[] {
  if (source.includes("\n")) return [parseToml(source)];
  if (existsSync(source) && statSync(source).isDirectory()) {
    const tomls = collectTomls(source).sort();
    if (!tomls.length) throw new Error(`no .toml specs under ${source}`);
    return tomls.map((t) => parseTomlFile(t));
  }
  return [parseTomlFile(source)];
}

function collectTomls(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTomls(full));
    else if (entry.isFile() && entry.name.endsWith(".toml")) out.push(full);
  }
  return out;
}

function specMode(spec: TomlSpec, tomlMode: TomlMode): "plan" | "request" {
  if (tomlMode === "plan" || tomlMode === "request") return tomlMode;
  return spec.mode;
}

/**
 * Turn TOML specs into a red Vitest + RTL suite plus build briefs.
 *
 * `source` is raw TOML text, a `.toml` spec file, or a directory of them. For
 * each spec, writes into `outDir`:
 *
 * - `<slug>.test.tsx` — the failing suite (the specification)
 * - `<slug>.plan.json` — the reviewable plan the tests were rendered from
 * - `BRIEF_<slug>.md` — the building instruction for the implementer
 * - `sdd-setup.ts` — the shared RTL harness + `bddPending` marker (written once)
 *
 * Each successful build is a timestamped *run*. After every spec passes its
 * gates and all artifacts are written, the build commits a completion marker
 * `DONE.json` and appends to the append-only history `.sdd-runs.json` (see
 * {@link module:runs}). Both carry a sortable `runId` (`YYYYMMDDThhmmssZ`), so a
 * later generation can resolve the latest completed run ({@link latestRun}). A
 * build that throws (safety violation, or strict coverage failure) never
 * commits — the previous `DONE.json` remains the last known-good run.
 *
 * The plan is cross-checked deterministically ({@link validatePlan}): every
 * scenario, every diagram message, and every required rule/edge id must be
 * covered by at least one test case. With `strict=true` (default) a failing
 * check raises {@link PlanValidationError} after writing the plan JSON for
 * inspection; with `strict=false` problems are listed in the brief instead.
 *
 * Before rendering, every plan (both modes, regardless of `strict`) passes an
 * AST safety gate ({@link scanPlan}): a case's `given`/`when`/`then` and
 * fixture bodies become executable TS/JSX, so imports, dangerous
 * builtins/globals, reflection, or non-TS raise {@link PlanSafetyError} and
 * nothing runnable is written. This is defense-in-depth, not a sandbox — a
 * human must still review the generated suite before running it anywhere with
 * secrets or network access.
 *
 * Review the plan and tests before pointing an implementer at the brief: once
 * the suite is treated as the spec, a misread scenario is locked in.
 */
export async function build(
  source: string,
  outDir: string,
  options: BuildOptions = {},
): Promise<BuildResult[]> {
  const { apiHint = null, strict = true, tomlMode = "auto", chat } = options;
  const startedAt = options.now ? options.now() : new Date();
  const runId = options.runId ?? toRunId(startedAt);

  // Project-local config: dependencies to inject, runner, and web/native platform.
  // Resolve from the output dir when the caller didn't pass one explicitly.
  const config = options.config ?? resolveConfig({ searchFrom: outDir });
  const renderConfig = {
    runner: config.runner,
    platform: config.platform,
    setupModule: config.setupModule,
    extraImports: aliasImports(config),
    providers: config.providers,
  };

  mkdirSync(outDir, { recursive: true });
  const setupPath = join(outDir, "sdd-setup.ts");
  if (!existsSync(setupPath)) writeFileSync(setupPath, renderSetup(renderConfig), "utf-8");

  const results: BuildResult[] = [];
  const specEntries: RunSpecEntry[] = [];
  for (const spec of discover(source)) {
    let testPlan: TestPlan;
    if (specMode(spec, tomlMode) === "plan") {
      testPlan = spec.toTestPlan(); // NO LLM
    } else {
      if (!chat) {
        throw new Error(
          `request-mode spec ${JSON.stringify(spec.meta.featureName)} needs a ChatClient; ` +
            `pass { chat } to build() or add [[cases]] for plan mode`,
        );
      }
      testPlan = await planFromSpec(spec, { apiHint, chat });
    }

    const slug = spec.slug;
    const sourceName = spec.meta.featureName;
    const testFile = `${slug}.test.tsx`;
    const planFile = `${slug}.plan.json`;
    const briefFile = `BRIEF_${slug}.md`;
    const testPath = join(outDir, testFile);
    const planPath = join(outDir, planFile);
    const briefPath = join(outDir, briefFile);

    writeFileSync(planPath, JSON.stringify(testPlan, null, 2) + "\n", "utf-8");

    // Safety gate first, and unconditionally: an unsafe executable string must
    // never be downgraded to a warning the way a coverage gap can. Throwing here
    // leaves the run UNCOMMITTED — no DONE.json / manifest entry is written, so
    // the previous completed run stays the resolved latest.
    const safetyProblems = scanPlan(testPlan);
    if (safetyProblems.length) throw new PlanSafetyError(sourceName, safetyProblems);

    const problems = validatePlan(testPlan, {
      scenarioNames: spec.scenarioNames(),
      messageIds: spec.messageIds(),
      requiredIds: spec.requiredIds(),
    });
    if (problems.length && strict) throw new PlanValidationError(sourceName, problems);

    writeFileSync(testPath, renderTests(testPlan, renderConfig), "utf-8");
    writeFileSync(
      briefPath,
      renderBrief(spec, testPlan, { testsPath: testPath, problems }),
      "utf-8",
    );

    const claimed = new Set<string>();
    for (const c of testPlan.cases) for (const id of c.covers) claimed.add(id);
    specEntries.push({
      feature: sourceName,
      slug,
      mode: specMode(spec, tomlMode),
      caseCount: testPlan.cases.length,
      files: [testFile, planFile, briefFile],
      coveredScenarios: [...spec.scenarioNames()].sort(),
      coveredIds: [...claimed].sort(),
    });
    // runId is filled in after commit (it may be de-collided for same-second runs).
    results.push({ feature: spec, plan: testPlan, testPath, planPath, briefPath, runId: "" });
  }

  // Only now — every spec passed its gates and every artifact is on disk — is
  // the run marked complete. DONE.json + the manifest entry are the signal that
  // this generation finished; a partial/failed run never reaches here. commitRun
  // may adjust the id so same-second regenerations stay uniquely ordered.
  const committed = commitRun(outDir, {
    runId,
    completedAt: startedAt.toISOString(),
    tool: TOOL,
    specs: specEntries,
  });

  return results.map((r) => ({ ...r, runId: committed.runId }));
}
