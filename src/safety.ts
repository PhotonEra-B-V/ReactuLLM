/**
 * AST safety gate for the executable strings in a {@link TestPlan}.
 *
 * The SDD pipeline renders LLM-authored (request mode) or hand-authored (plan
 * mode) strings — a case's `given`/`when`/`then` and fixture bodies — verbatim
 * into a Vitest module that someone then runs. Every such string is therefore
 * executable TypeScript/JSX. This module screens those strings *before*
 * rendering so a hallucinated `import fs from 'fs'` or a prompt-injected
 * `process.env.SECRET` exfiltration fails the build loudly instead of landing
 * on disk as runnable code.
 *
 * **This is defense-in-depth, not a sandbox.** It is a denylist over a Babel
 * AST walk: it reliably catches accidents and low-effort payloads, and it is
 * far harder to fool than a substring scan, but a determined attacker can
 * construct code that evades any static denylist. The real trust boundary is
 * *procedural*:
 *
 * 1. A spec's text reaches the request-mode planner prompt, so an untrusted
 *    `.toml` is a prompt-injection vector — review spec provenance before
 *    generation.
 * 2. The rendered suite is arbitrary code — a human must review the diff before
 *    it runs anywhere with secrets or network access.
 *
 * The gate runs in BOTH modes (plan mode has no LLM, but a hand-authored /
 * PR-supplied `.toml` is just as capable of arbitrary code execution). It also
 * parses each string, so syntactically invalid input (a common request-mode
 * model failure) is caught here rather than at Vitest import time.
 *
 * A faithful twin of `pyllm.bdd.safety`, retargeted from Python's `ast` to the
 * `@babel/parser` TS/JSX AST.
 */

import { parse as babelParse } from "@babel/parser";
import type { File, Node } from "@babel/types";

import type { TestPlan } from "./schema.js";

/**
 * Root identifiers whose mere use is disallowed in a spec's executable strings.
 * These are the common vectors for filesystem/process/network/reflection
 * escapes and secret exfiltration; a component/hook test never legitimately
 * needs them in an act-or-assert statement.
 */
const BANNED_NAMES: ReadonlySet<string> = new Set([
  "process",
  "globalThis",
  "global",
  "window",
  "document",
  "require",
  "module",
  "__dirname",
  "__filename",
  "Function",
  "eval",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "localStorage",
  "sessionStorage",
  "Deno",
  "Bun",
]);

/** Callees that are dangerous regardless of how they are named/aliased. */
const BANNED_CALLS: ReadonlySet<string> = new Set([
  "eval",
  "require",
  "Function",
  "fetch",
  "import",
]);

/** Member names whose access is a reflection/exfil escape. */
const BANNED_MEMBERS: ReadonlySet<string> = new Set([
  "constructor",
  "__proto__",
  "prototype",
]);

class Screen {
  readonly problems: string[] = [];
  constructor(private readonly where: string) {}

  private flag(msg: string): void {
    this.problems.push(`${this.where}: ${msg}`);
  }

  walk(node: Node | null | undefined): void {
    if (!node || typeof node !== "object") return;
    this.inspect(node);
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) this.walk(child as Node);
      } else if (value && typeof value === "object" && "type" in (value as object)) {
        this.walk(value as Node);
      }
    }
  }

  private inspect(node: Node): void {
    switch (node.type) {
      case "ImportDeclaration":
        this.flag(`import statement is not allowed (from ${node.source.value})`);
        break;
      case "ImportExpression":
        // dynamic import('...') — a code-loading escape.
        this.flag("dynamic import() is not allowed");
        break;
      case "Identifier":
        if (BANNED_NAMES.has(node.name)) this.flag(`disallowed name ${JSON.stringify(node.name)}`);
        break;
      case "MemberExpression":
      case "OptionalMemberExpression": {
        const prop = node.property;
        if (!node.computed && prop.type === "Identifier" && BANNED_MEMBERS.has(prop.name)) {
          this.flag(`reflection member access is not allowed (.${prop.name})`);
        }
        // computed __proto__/constructor via string literal, e.g. x["constructor"]
        if (node.computed && prop.type === "StringLiteral" && BANNED_MEMBERS.has(prop.value)) {
          this.flag(`reflection member access is not allowed ([${JSON.stringify(prop.value)}])`);
        }
        break;
      }
      case "CallExpression":
      case "OptionalCallExpression":
      case "NewExpression": {
        const callee = node.callee;
        // Babel emits `import(...)` as a CallExpression whose callee is `Import`.
        if (callee.type === "Import") {
          this.flag("dynamic import() is not allowed");
        } else if (callee.type === "Identifier" && BANNED_CALLS.has(callee.name)) {
          this.flag(`call to disallowed callable ${JSON.stringify(callee.name)}`);
        } else if (
          (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          BANNED_CALLS.has(callee.property.name)
        ) {
          this.flag(`call to disallowed function ${JSON.stringify(callee.property.name)}`);
        }
        break;
      }
      default:
        break;
    }
  }
}

function parseSource(source: string, where: string): { ast: File | null; error: string | null } {
  try {
    const ast = babelParse(source, {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: ["typescript", "jsx"],
    });
    return { ast, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ast: null, error: `${where}: not valid TypeScript/JSX (${msg})` };
  }
}

/** Parse and screen one executable string. */
function scanSource(source: string, where: string): string[] {
  const trimmed = source.trim();
  if (!trimmed || trimmed === "None") return [];
  const { ast, error } = parseSource(trimmed, where);
  if (error !== null || ast === null) return [error ?? `${where}: not valid TypeScript/JSX`];
  const screen = new Screen(where);
  screen.walk(ast.program);
  return screen.problems;
}

/**
 * Return human-readable safety problems; an empty array means the plan is
 * clean.
 *
 * Screens every executable string that {@link module:renderer} would emit
 * verbatim — each case's `given` statements, its `when` act expression, each
 * `then` assertion, and every fixture body line — rejecting imports, `require`,
 * `eval`/`Function`, dynamic `import()`, process/globalThis/window reflection
 * and secret exfiltration, and non-parseable input. `given` and fixture bodies
 * are screened as a whole block (multi-statement setup), matching how the
 * renderer emits them.
 *
 * Not a sandbox: see the module docstring. This turns silent code execution
 * into a loud build failure and validates the strings are real TS/JSX.
 */
export function scanPlan(plan: TestPlan): string[] {
  const problems: string[] = [];

  for (const fixture of plan.fixtures) {
    problems.push(...scanSource(fixture.body.join("\n"), `fixture ${JSON.stringify(fixture.name)} body`));
  }

  for (const c of plan.cases) {
    const tag = c.testName;
    // 'given' entries render as consecutive body lines, so the canonical
    // error-path / render-setup form spans several entries; screen them as one
    // block, not line-by-line.
    if (c.given.length) {
      problems.push(...scanSource(c.given.join("\n"), `case ${JSON.stringify(tag)} given`));
    }
    problems.push(...scanSource(c.when, `case ${JSON.stringify(tag)} when`));
    c.then.forEach((expr, i) => {
      problems.push(...scanSource(expr, `case ${JSON.stringify(tag)} then[${i}]`));
    });
  }

  return problems;
}
