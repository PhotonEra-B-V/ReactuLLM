/**
 * Deterministic cross-checks between the spec and the LLM-produced plan.
 *
 * This is the airtight half of the pipeline: coverage accounting happens in
 * plain code, never by asking the model whether it covered everything. A plan
 * that drops a scenario, ignores a sequence-diagram message, skips a required
 * rule/edge id, or claims an id that doesn't exist fails the build.
 *
 * A faithful twin of `pyllm.bdd.checks`. `validatePlan` is intentionally
 * decoupled from any spec type: it takes plain `Set`s of names/ids so the same
 * gate serves both the React and Python front-ends.
 */

import type { TestPlan } from "./schema.js";

/** Sort 'M1', 'M2', ... numerically; fall back to lexical for other ids. */
function messageSortKey(mid: string): [number, string] {
  if (mid.startsWith("M") && /^\d+$/.test(mid.slice(1))) {
    return [0, String(Number.parseInt(mid.slice(1), 10)).padStart(20, "0")];
  }
  return [1, mid];
}

function sortByMessageKey(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const [ra, sa] = messageSortKey(a);
    const [rb, sb] = messageSortKey(b);
    return ra - rb || (sa < sb ? -1 : sa > sb ? 1 : 0);
  });
}

function difference(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out;
}

/**
 * Return human-readable problems; an empty array means the plan is sound.
 *
 * `scenarioNames` are the scenarios every plan must cover (matched against
 * `TestCase.scenario`). `messageIds` (sequence-diagram message ids) and
 * `requiredIds` (rule/edge ids) are BOTH valid targets for `TestCase.covers`;
 * every id in either set must be claimed by some case, and any claimed id
 * outside their union is rejected as unknown.
 */
export function validatePlan(
  plan: TestPlan,
  args: {
    scenarioNames: Set<string>;
    messageIds: Set<string>;
    requiredIds: Set<string>;
  },
): string[] {
  const { scenarioNames, messageIds, requiredIds } = args;
  const problems: string[] = [];

  const coveredScenarios = new Set(plan.cases.map((c) => c.scenario));
  for (const scenario of [...scenarioNames].sort()) {
    if (!coveredScenarios.has(scenario)) {
      problems.push(`scenario not covered by any test case: ${JSON.stringify(scenario)}`);
    }
  }

  const validIds = new Set<string>([...messageIds, ...requiredIds]);
  const claimed = new Set<string>();
  for (const c of plan.cases) for (const mid of c.covers) claimed.add(mid);

  for (const cid of difference(claimed, validIds).sort()) {
    problems.push(`test case claims unknown id: ${JSON.stringify(cid)}`);
  }

  for (const mid of sortByMessageKey(difference(messageIds, claimed))) {
    problems.push(`sequence message not covered by any test case: ${mid}`);
  }

  for (const rid of difference(requiredIds, claimed).sort()) {
    problems.push(`rule/edge case not covered by any test case: ${rid}`);
  }

  const seen = new Set<string>();
  for (const c of plan.cases) {
    if (seen.has(c.testName)) {
      problems.push(`duplicate test name in plan: ${JSON.stringify(c.testName)}`);
    }
    seen.add(c.testName);
  }

  return problems;
}
