/**
 * Render the implementation brief — the building instruction an agent (or
 * human) follows to turn the red suite green.
 *
 * A faithful twin of `pyllm.bdd.brief`, retargeted to a React component/hook
 * deliverable. Only reads the spec's `meta.description`, `sequences`, `rules`,
 * and `edgeCases`; everything else comes from the plan.
 */

import type { TestPlan } from "./schema.js";
import type { SequenceDiagram } from "./sequence.js";

interface BriefSpec {
  meta?: { description?: string };
  description?: string;
  sequences?: readonly SequenceDiagram[];
  rules?: readonly { id: string; text: string }[];
  edgeCases?: readonly { id: string; text: string }[];
}

export function renderBrief(
  spec: BriefSpec,
  plan: TestPlan,
  options: { testsPath: string; problems?: string[] | null },
): string {
  const { testsPath, problems } = options;
  const sequences = spec.sequences ?? [];
  const rules = spec.rules ?? [];
  const edgeCases = spec.edgeCases ?? [];

  const lines: string[] = [`# BUILD BRIEF: ${plan.feature}`, ""];
  const description = spec.meta?.description ?? spec.description ?? "";
  if (description) {
    lines.push(description, "");
  }

  if (problems && problems.length) {
    lines.push("## ⚠ Plan validation warnings", "");
    lines.push(...problems.map((p) => `- ${p}`));
    lines.push("");
  }

  lines.push("## Target API (implement exactly these signatures)", "");
  lines.push(`Module: \`${plan.api.module}\``, "");
  lines.push("```tsx");
  lines.push(...plan.api.signatures);
  lines.push("```", "");

  if (sequences.length) {
    lines.push("## Collaboration contract", "");
    lines.push("The implementation must produce these interactions, in order —");
    lines.push("the suite asserts recorded call sequences against them.", "");
    for (const diagram of sequences) {
      lines.push("```mermaid", diagram.source, "```", "");
    }
  }

  lines.push(`## Test manifest (${plan.cases.length} cases, all currently red)`, "");
  lines.push("| Test | Scenario | Kind | Covers |");
  lines.push("|------|----------|------|--------|");
  for (const c of plan.cases) {
    const kind = c.edgeCase ? "edge case" : "scenario";
    const covers = c.covers.length ? c.covers.join(", ") : "—";
    lines.push(`| \`${c.testName}\` | ${c.scenario} | ${kind} | ${covers} |`);
  }
  lines.push("");

  if (sequences.length) {
    lines.push("### Message traceability", "");
    lines.push("| Message | Interaction | Tests |");
    lines.push("|---------|-------------|-------|");
    for (const diagram of sequences) {
      for (const message of diagram.messages) {
        const tests = plan.cases.filter((c) => c.covers.includes(message.id)).map((c) => c.testName);
        const shown = tests.length ? tests.map((t) => `\`${t}\``).join(", ") : "**uncovered**";
        lines.push(`| ${message.id} | ${message.sender} → ${message.receiver}: ${message.text} | ${shown} |`);
      }
    }
    lines.push("");
  }

  if (rules.length || edgeCases.length) {
    lines.push("### Rule/edge traceability", "");
    lines.push("| Id | Rule/Edge | Tests |");
    lines.push("|----|-----------|-------|");
    for (const item of [...rules, ...edgeCases]) {
      const tests = plan.cases.filter((c) => c.covers.includes(item.id)).map((c) => c.testName);
      const shown = tests.length ? tests.map((t) => `\`${t}\``).join(", ") : "**uncovered**";
      lines.push(`| ${item.id} | ${item.text} | ${shown} |`);
    }
    lines.push("");
  }

  lines.push("## Rules", "");
  lines.push(`- The tests in \`${testsPath}\` are the specification. They are`);
  lines.push("  read-only during implementation — if a test looks wrong, stop and");
  lines.push("  flag it; do not adapt the test to the implementation.");
  lines.push("- Each test's first line is a `bddPending()` marker. Delete exactly");
  lines.push("  that one line per test as you make it pass; change nothing else.");
  lines.push("- Implement only the API surface listed above; keep everything else");
  lines.push("  private.");
  lines.push("");

  lines.push("## Definition of done", "");
  lines.push(`\`vitest run ${testsPath}\` passes with the only edit being the removal`);
  lines.push("of each test's `bddPending()` marker line.");
  return lines.join("\n") + "\n";
}
