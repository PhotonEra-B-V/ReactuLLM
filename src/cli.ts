#!/usr/bin/env node
/**
 * CLI: `react-sdd specs/ --out src/__generated__`
 *
 * A faithful twin of `python -m pyllm.bdd`. Plan-mode specs (with `[[cases]]`)
 * build with no LLM and no configuration. Request-mode specs need a
 * {@link ChatClient}; supply one with `--chat-module ./path/to/chat.ts`, a
 * module whose default export (or named `createChat`) returns a `ChatClient`.
 */

import type { ChatClient } from "./chat.js";
import { build, type BuildResult, type TomlMode } from "./builder.js";
import { resolveConfig } from "./config.js";
import { latestRun, readManifest } from "./runs.js";
import type { RenderConfig } from "./renderer.js";

interface Args {
  source: string;
  out: string;
  apiHint: string | null;
  tomlMode: TomlMode;
  chatModule: string | null;
  configPath: string | null;
  platform: RenderConfig["platform"] | null;
  runner: RenderConfig["runner"] | null;
  listRuns: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: "",
    out: "src/__generated__",
    apiHint: null,
    tomlMode: "auto",
    chatModule: null,
    configPath: null,
    platform: null,
    runner: null,
    listRuns: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--out":
        args.out = next();
        break;
      case "--api-hint":
        args.apiHint = next();
        break;
      case "--toml-mode": {
        const mode = next();
        if (mode !== "auto" && mode !== "plan" && mode !== "request") {
          throw new Error(`--toml-mode must be auto|plan|request, got ${mode}`);
        }
        args.tomlMode = mode;
        break;
      }
      case "--chat-module":
        args.chatModule = next();
        break;
      case "--config":
        args.configPath = next();
        break;
      case "--platform": {
        const p = next();
        if (p !== "web" && p !== "native") {
          throw new Error(`--platform must be web|native, got ${p}`);
        }
        args.platform = p;
        break;
      }
      case "--runner": {
        const r = next();
        if (r !== "jest" && r !== "vitest") {
          throw new Error(`--runner must be jest|vitest, got ${r}`);
        }
        args.runner = r;
        break;
      }
      case "--list-runs":
        args.listRuns = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}`);
        rest.push(arg);
    }
  }
  // --list-runs inspects an output dir and needs no <source>.
  if (!args.listRuns) {
    if (!rest.length) throw new Error("a .toml spec file or a directory is required");
    args.source = rest[0]!;
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    `react-sdd — turn a .toml spec into a red Jest/Vitest + RTL suite plus build briefs.

Usage:
  react-sdd <source> [--out DIR] [--toml-mode auto|plan|request]
            [--api-hint TEXT] [--chat-module PATH]
            [--config PATH] [--platform web|native] [--runner jest|vitest]
  react-sdd --list-runs [--out DIR]

  <source>         a .toml spec file or a directory containing them
  --out            output directory (default: src/__generated__)
  --toml-mode      'plan' uses hand-written [[cases]] (no LLM); 'request' has
                   the planner LLM fill the plan; 'auto' (default) detects from
                   the presence of [[cases]]
  --api-hint       pin the target module / existing signatures
  --chat-module    module exporting createChat(): ChatClient — required for
                   request-mode specs
  --config         path to reactullm.config.json (default: discovered by
                   walking up from --out); supplies dependencies, platform,
                   runner, and providers for the target project
  --platform       'web' (default) or 'native' (React Native Testing Library);
                   overrides the config file
  --runner         'jest' (default) or 'vitest'; overrides the config file
  --list-runs      print the completed-run history for --out and exit
`,
  );
}

function printLatest(outDir: string): void {
  const latest = latestRun(outDir);
  if (!latest) {
    process.stdout.write(`No completed run in ${outDir} yet.\n`);
    return;
  }
  const specs = latest.specs.map((s) => s.slug).join(", ") || "—";
  process.stdout.write(
    `Latest completed run in ${outDir}: ${latest.runId} ` +
      `(${latest.specs.length} spec(s): ${specs})\n`,
  );
}

function listRuns(outDir: string): number {
  const { runs } = readManifest(outDir);
  if (!runs.length) {
    process.stdout.write(`No completed runs recorded in ${outDir}.\n`);
    return 0;
  }
  process.stdout.write(`Run history for ${outDir} (oldest first):\n`);
  for (const run of runs) {
    const specs = run.specs.map((s) => `${s.slug}(${s.caseCount})`).join(", ");
    process.stdout.write(`  ${run.runId}  ${run.tool}  ${specs}\n`);
  }
  const latest = latestRun(outDir);
  if (latest) process.stdout.write(`Latest: ${latest.runId}\n`);
  return 0;
}

async function loadChat(chatModule: string | null): Promise<ChatClient | undefined> {
  if (!chatModule) return undefined;
  const mod = (await import(chatModule)) as Record<string, unknown>;
  const factory = (mod["createChat"] ?? mod["default"]) as (() => ChatClient) | undefined;
  if (typeof factory !== "function") {
    throw new Error(`--chat-module ${chatModule} must export createChat(): ChatClient`);
  }
  return factory();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.listRuns) return listRuns(args.out);

  const chat = await loadChat(args.chatModule);

  // Resolve project-local config (dependencies/platform/runner). CLI flags win
  // over the file, which wins over defaults. Discovery walks up from --out.
  const overrides: Partial<Pick<RenderConfig, "runner" | "platform">> = {};
  if (args.platform) overrides.platform = args.platform;
  if (args.runner) overrides.runner = args.runner;
  const config = resolveConfig({
    searchFrom: args.out,
    configPath: args.configPath,
    overrides,
  });
  if (config.sourcePath) {
    process.stdout.write(
      `Config: ${config.sourcePath} (platform=${config.platform}, runner=${config.runner}, ` +
        `${config.dependencies.length} dep(s))\n`,
    );
  }

  // Show which run a fresh generation is building on top of.
  printLatest(args.out);

  const results: BuildResult[] = await build(args.source, args.out, {
    apiHint: args.apiHint,
    tomlMode: args.tomlMode,
    config,
    ...(chat ? { chat } : {}),
  });

  const runId = results[0]?.runId;
  for (const result of results) {
    process.stdout.write(`${result.plan.feature}: ${result.plan.cases.length} tests\n`);
    for (const path of [result.testPath, result.planPath, result.briefPath]) {
      process.stdout.write(`  ${path}\n`);
    }
  }
  if (runId) process.stdout.write(`\n✓ Run ${runId} committed (DONE.json updated).\n`);
  return 0;
}

// Run when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
