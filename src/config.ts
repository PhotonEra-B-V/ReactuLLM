/**
 * Project-local generation config — `reactullm.config.json`.
 *
 * ReactLLM is meant to be installed INTO a target project (a web app or a React
 * Native app) and to read its generation settings from that project, rather than
 * having every `.toml` spec re-declare the same import lines. A
 * `reactullm.config.json` at the project root (or any parent of the output
 * directory) supplies:
 *
 * - the test-runner and platform to target (`runner`, `platform`) — the
 *   `platform: "native"` switch retargets the whole harness to React Native;
 * - the shared setup module specifier (`setupModule`);
 * - **dependency import lines** (`dependencies` / `importAliases`) the project
 *   already depends on, so a spec can pull them in by short alias instead of
 *   retyping the full `import { ... } from "..."` statement;
 * - provider imports for the generated `renderWithProviders` wrapper
 *   (`providers`).
 *
 * Discovery walks up from the output directory (then the cwd), the way ESLint /
 * Prettier find their config, so `react-sdd specs/ --out app/src/__generated__`
 * picks up the app's config automatically. CLI flags override file values, which
 * override built-in defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DEFAULT_RENDER_CONFIG, type RenderConfig } from "./renderer.js";

/** The config filename discovered in the target project. */
export const CONFIG_FILENAME = "reactullm.config.json";

/**
 * A named dependency the generator can inject into a suite by alias.
 *
 * `import` is the exact statement emitted into the test file when a spec (or a
 * provider entry) references this dependency's `name`. `provider`, when set,
 * marks it as usable in the `renderWithProviders` wrapper.
 */
export interface DependencyEntry {
  /** Short alias a spec refers to, e.g. "redux", "router", "radixTheme". */
  readonly name: string;
  /**
   * The exact import statement to emit, e.g.
   * `import { Provider } from "react-redux"`.
   */
  readonly import: string;
  /** Free-form note (e.g. which package/version this maps to). */
  readonly note?: string;
}

/**
 * The shape of `reactullm.config.json`. Every field is optional; an empty file
 * (`{}`) reproduces the built-in defaults.
 */
export interface ReactUllmConfig {
  /** "jest" (default) or "vitest". */
  runner?: RenderConfig["runner"];
  /** "web" (default, DOM RTL) or "native" (React Native Testing Library). */
  platform?: RenderConfig["platform"];
  /** Import specifier for the shared SDD harness (default "./sdd-setup"). */
  setupModule?: string;
  /**
   * Dependencies the project already ships, exposed to specs by alias so a spec
   * needn't retype their import lines. Emitted into a suite when referenced.
   */
  dependencies?: readonly DependencyEntry[];
  /**
   * Aliases to auto-inject into EVERY generated suite, by `dependencies[].name`.
   * Use for cross-cutting imports (e.g. a global test i18n instance).
   */
  importAliases?: readonly string[];
  /**
   * Provider imports for the generated `renderWithProviders` wrapper, as exact
   * import lines, e.g. `import { MemoryRouter } from "react-router-dom"`.
   */
  providers?: readonly string[];
}

/** RenderConfig plus the resolved dependency surface, ready for the renderer. */
export interface ResolvedConfig extends RenderConfig {
  readonly dependencies: readonly DependencyEntry[];
  readonly importAliases: readonly string[];
  readonly providers: readonly string[];
  /** Absolute path of the config file that was loaded, or null if none. */
  readonly sourcePath: string | null;
}

/**
 * Walk up from `start` looking for {@link CONFIG_FILENAME}. Returns the first
 * match's absolute path, or null when none is found before the filesystem root.
 */
export function findConfigFile(start: string): string | null {
  let dir = resolve(start);
  // Stop when dirname() stops changing (filesystem root).
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function validate(raw: unknown, path: string): ReactUllmConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: top level must be a JSON object`);
  }
  const cfg = raw as Record<string, unknown>;

  if (cfg.runner !== undefined && cfg.runner !== "jest" && cfg.runner !== "vitest") {
    throw new Error(`${path}: "runner" must be "jest" or "vitest"`);
  }
  if (cfg.platform !== undefined && cfg.platform !== "web" && cfg.platform !== "native") {
    throw new Error(`${path}: "platform" must be "web" or "native"`);
  }
  if (cfg.setupModule !== undefined && typeof cfg.setupModule !== "string") {
    throw new Error(`${path}: "setupModule" must be a string`);
  }
  const deps = cfg.dependencies;
  if (deps !== undefined) {
    if (!Array.isArray(deps)) throw new Error(`${path}: "dependencies" must be an array`);
    deps.forEach((d, i) => {
      const e = d as Record<string, unknown>;
      if (!e || typeof e.name !== "string" || typeof e.import !== "string") {
        throw new Error(
          `${path}: dependencies[${i}] must have string "name" and "import" fields`,
        );
      }
    });
  }
  for (const key of ["importAliases", "providers"] as const) {
    const v = cfg[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
      throw new Error(`${path}: "${key}" must be an array of strings`);
    }
  }
  return cfg as ReactUllmConfig;
}

/**
 * Resolve a {@link ResolvedConfig} from an optional file plus CLI overrides.
 *
 * `overrides` (from CLI flags) win over the file, which wins over the built-in
 * {@link DEFAULT_RENDER_CONFIG}. Pass `configPath` to load a specific file;
 * otherwise discovery walks up from `searchFrom` (typically the `--out` dir).
 * `dependencies`, `importAliases`, and `providers` come only from the file.
 *
 * Every referenced `importAliases` entry must name a known dependency; an
 * unknown alias is a hard error so a typo fails the build instead of silently
 * dropping an import.
 */
export function resolveConfig(options: {
  searchFrom?: string;
  configPath?: string | null;
  overrides?: Partial<Pick<RenderConfig, "runner" | "platform" | "setupModule">>;
} = {}): ResolvedConfig {
  const { searchFrom = process.cwd(), configPath = null, overrides = {} } = options;

  const path = configPath ?? findConfigFile(searchFrom);
  let file: ReactUllmConfig = {};
  if (path) {
    if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      throw new Error(`${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    file = validate(parsed, path);
  }

  const dependencies = file.dependencies ?? [];
  const importAliases = file.importAliases ?? [];
  const known = new Set(dependencies.map((d) => d.name));
  for (const alias of importAliases) {
    if (!known.has(alias)) {
      throw new Error(
        `${path ?? CONFIG_FILENAME}: importAliases entry "${alias}" is not a declared dependency`,
      );
    }
  }

  return {
    runner: overrides.runner ?? file.runner ?? DEFAULT_RENDER_CONFIG.runner,
    platform: overrides.platform ?? file.platform ?? DEFAULT_RENDER_CONFIG.platform,
    setupModule: overrides.setupModule ?? file.setupModule ?? DEFAULT_RENDER_CONFIG.setupModule,
    dependencies,
    importAliases,
    providers: file.providers ?? [],
    sourcePath: path,
  };
}

/**
 * The import lines to auto-inject into every suite: the `import` statement of
 * each dependency named in `importAliases`, in declared order.
 */
export function aliasImports(config: ResolvedConfig): string[] {
  const byName = new Map(config.dependencies.map((d) => [d.name, d.import]));
  return config.importAliases.map((a) => byName.get(a)!).filter(Boolean);
}