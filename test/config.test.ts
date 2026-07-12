/**
 * Project-local config: `reactullm.config.json` discovery, dependency
 * injection, and the web/native platform switch.
 *
 * Proves the invariants the feature promises:
 * - config is discovered by walking up from the output dir;
 * - declared dependencies named in `importAliases` land in the generated suite;
 * - `platform: "native"` retargets the RTL import and drops DOM userEvent;
 * - CLI-style overrides beat the file, which beats the defaults;
 * - a bad config (unknown alias, wrong types) fails loudly.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parse as babelParse } from "@babel/parser";

import {
  aliasImports,
  build,
  findConfigFile,
  renderSetup,
  renderTests,
  resolveConfig,
} from "../src/index.js";
import { samplePlan } from "./fixtures.js";

function compiles(source: string): void {
  babelParse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cfg-"));
}

function writeConfig(dir: string, cfg: unknown): string {
  const path = join(dir, "reactullm.config.json");
  writeFileSync(path, JSON.stringify(cfg), "utf-8");
  return path;
}

describe("config discovery", () => {
  it("walks up from a nested dir to find reactullm.config.json", () => {
    const root = tmp();
    const path = writeConfig(root, {});
    const nested = join(root, "app", "src", "__generated__");
    expect(findConfigFile(nested)).toBe(path);
  });

  it("returns null when no config exists above the search dir", () => {
    expect(findConfigFile(tmp())).toBeNull();
  });

  it("defaults to jest/web with no dependencies when no file is found", () => {
    const cfg = resolveConfig({ searchFrom: tmp() });
    expect(cfg.runner).toBe("jest");
    expect(cfg.platform).toBe("web");
    expect(cfg.dependencies).toEqual([]);
    expect(cfg.sourcePath).toBeNull();
  });
});

describe("resolution & precedence", () => {
  it("reads runner/platform from the file", () => {
    const dir = tmp();
    writeConfig(dir, { runner: "vitest", platform: "native" });
    const cfg = resolveConfig({ searchFrom: dir });
    expect(cfg.runner).toBe("vitest");
    expect(cfg.platform).toBe("native");
  });

  it("lets CLI overrides beat the file", () => {
    const dir = tmp();
    writeConfig(dir, { runner: "vitest", platform: "native" });
    const cfg = resolveConfig({
      searchFrom: dir,
      overrides: { platform: "web" },
    });
    expect(cfg.platform).toBe("web"); // override wins
    expect(cfg.runner).toBe("vitest"); // file value kept where not overridden
  });

  it("resolves aliasImports from declared dependencies in declared order", () => {
    const dir = tmp();
    writeConfig(dir, {
      dependencies: [
        { name: "clsx", import: 'import clsx from "clsx";' },
        { name: "router", import: 'import { MemoryRouter } from "react-router-dom";' },
      ],
      importAliases: ["router", "clsx"],
    });
    const cfg = resolveConfig({ searchFrom: dir });
    expect(aliasImports(cfg)).toEqual([
      'import { MemoryRouter } from "react-router-dom";',
      'import clsx from "clsx";',
    ]);
  });
});

describe("validation", () => {
  it("rejects an importAliases entry that is not a declared dependency", () => {
    const dir = tmp();
    writeConfig(dir, { importAliases: ["ghost"] });
    expect(() => resolveConfig({ searchFrom: dir })).toThrow(/ghost/);
  });

  it("rejects a bad platform value", () => {
    const dir = tmp();
    writeConfig(dir, { platform: "ios" });
    expect(() => resolveConfig({ searchFrom: dir })).toThrow(/platform/);
  });

  it("rejects a dependency missing its import line", () => {
    const dir = tmp();
    writeConfig(dir, { dependencies: [{ name: "x" }] });
    expect(() => resolveConfig({ searchFrom: dir })).toThrow(/import/);
  });
});

describe("rendering with config", () => {
  it("injects alias imports into the generated suite", () => {
    const source = renderTests(samplePlan(), {
      runner: "jest",
      platform: "web",
      setupModule: "./sdd-setup",
      extraImports: ['import clsx from "clsx";'],
      providers: [],
    });
    expect(source).toContain('import clsx from "clsx";');
    compiles(source);
  });

  it("targets React Native Testing Library on platform=native", () => {
    const source = renderTests(samplePlan(), {
      runner: "jest",
      platform: "native",
      setupModule: "./sdd-setup",
    });
    expect(source).toContain('from "@testing-library/react-native"');
    expect(source).not.toContain("@testing-library/user-event");
    expect(source).toContain("fireEvent");
    compiles(source);
  });

  it("renderSetup emits provider imports and the native RTL package", () => {
    const setup = renderSetup({
      runner: "jest",
      platform: "native",
      setupModule: "./sdd-setup",
      providers: ['import { Provider } from "react-redux";'],
    });
    expect(setup).toContain('from "@testing-library/react-native"');
    expect(setup).toContain('import { Provider } from "react-redux";');
    compiles(setup);
  });
});

describe("end-to-end build with config", () => {
  it("build() picks up a config beside the output dir and injects deps", async () => {
    const dir = tmp();
    const out = join(dir, "__generated__");
    writeConfig(dir, {
      platform: "native",
      dependencies: [{ name: "clsx", import: 'import clsx from "clsx";' }],
      importAliases: ["clsx"],
    });
    const specPath = join(dir, "feature.toml");
    writeFileSync(
      specPath,
      [
        "[meta]",
        'feature_name = "Counter"',
        "[api]",
        'module = "@/hooks/useCounter"',
        'imports = ["import { useCounter } from \\"@/hooks/useCounter\\""]',
        'signatures = ["export function useCounter(): { count: number }"]',
        "[[cases]]",
        'test_name = "starts at zero"',
        'scenario = "initial"',
        'when = "None"',
        'then = ["expect(true).toBe(true)"]',
      ].join("\n"),
      "utf-8",
    );

    const results = await build(specPath, out);
    const testSource = readFileSync(results[0]!.testPath, "utf-8");
    expect(testSource).toContain('from "@testing-library/react-native"');
    expect(testSource).toContain('import clsx from "clsx";');

    const setupSource = readFileSync(join(out, "sdd-setup.ts"), "utf-8");
    expect(setupSource).toContain('from "@testing-library/react-native"');
  });
});