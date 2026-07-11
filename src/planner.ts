/**
 * Expand a request-mode TOML spec into a {@link TestPlan} via structured
 * output.
 *
 * {@link planFromSpec} uses the structured-output pattern
 * (`withInstructions` / `withSchema` / `ask`): the model only ever fills
 * {@link TestPlanSchema}; it never writes test text. Plan-mode specs skip this
 * module entirely (`TomlSpec.toTestPlan` is deterministic, no LLM).
 *
 * A faithful twin of `pyllm.bdd.planner`, retargeted to React Testing Library
 * idioms and a {@link ChatClient} seam (dependency-injected so tests need no
 * network).
 */

import type { ChatClient } from "./chat.js";
import { type TestPlan, TestPlanSchema } from "./schema.js";
import type { TomlSpec } from "./tomlSpec.js";

export const SPEC_PLANNER_INSTRUCTIONS = `You are a React test architect. You receive one behavior specification (a
component/hook API surface plus rules, edge cases, and optional sequence
diagrams) and produce a test plan that will be rendered into a failing Vitest +
React Testing Library suite. The suite is written BEFORE any implementation
exists — it is the specification an implementer must satisfy without editing the
tests.

Rules:
- Commit to the public API surface exactly as given: module path, imports, and
  the exact TypeScript signatures. Every test must exercise only that surface.
- Write one or more test cases covering the rules, plus derived edge cases
  (boundaries, error/empty/loading states) marked edgeCase=true. Do not invent
  behavior the spec does not imply.
- 'given' entries, fixture bodies, 'when', and 'then' must be executable
  TypeScript/JSX against the declared API and React Testing Library. In 'given',
  set up props/mocks/store/router and RENDER the component with render(<... />),
  or render a hook with renderHook(() => useThing(...)). One statement per entry.
- 'when' is the SINGLE act, an expression assigned to \`result\`: a user
  interaction via userEvent (e.g. userEvent.click(screen.getByRole('button')))
  or a hook call wrapped in act(...). Include \`await\` and set isAsync=true when
  the act is async (userEvent, findBy*, waitFor almost always are). For a pure
  render assertion where the arrange step already rendered, set when = "None".
- 'then' entries are COMPLETE RTL assertion statements, each including the
  expect(...) wrapper, e.g. expect(screen.getByRole('button')).toBeDisabled()
  or expect(onSearch).toHaveBeenCalledWith('hello'). Do NOT write a bare boolean
  or prefix with 'assert' — write the line exactly as it appears in the test.
- Prefer real user-visible queries (getByRole/getByLabelText/findByText) and
  jest.fn() spies over deep mocks. Use fixtures only for setup shared by several
  cases; fixture bodies end with 'return'.
- testName values must be unique, human-readable it(...) titles.
- The harness is Jest + React Testing Library. describe/it/expect/jest are
  AMBIENT globals (do not import them). render/screen/userEvent/renderHook/act/
  waitFor are already imported by the generated file, and jest-dom matchers are
  registered by the project setup — do NOT add import statements for them (or
  anything else) in any string; imports are rejected by the safety gate.

COVERAGE IS MECHANICALLY ENFORCED — the build fails if any id is uncovered:
- Set 'covers' on each test case to the ids it exercises. Every rule id, every
  edge-case id, and every sequence-diagram message id listed below MUST appear
  in some case's 'covers'. Never invent ids; only claim ids that were given.

When sequence diagrams are present, they are binding collaboration contracts
(user → component → callback/store/router, in order):
- Design the API so collaborators named in a diagram are injectable (props /
  hook arguments) so tests can substitute recording fakes (vi.fn()).
- Add at least one interaction-order case: drive the user action, then assert
  the recorded call order matches the diagram (e.g. expect(onSearch.mock.calls)
  or expect(order).toEqual(['debounceStart', 'onSearch'])).`;

function specPrompt(spec: TomlSpec, apiHint: string | null): string {
  let prompt = spec.toPrompt();
  if (apiHint) {
    prompt += `\nTarget API constraints (honor these exactly):\n${apiHint}\n`;
  }
  return prompt;
}

/**
 * Ask a model to expand a loose (request-mode) {@link TomlSpec} into a
 * {@link TestPlan}.
 *
 * Only used when the TOML carries no hand-written `[[cases]]` (plan mode skips
 * the LLM entirely via `spec.toTestPlan()`). The prompt comes from
 * `spec.toPrompt()`; the model is instructed to claim EVERY rule, edge, and
 * sequence-message id in some case's `covers` — uncovered ids fail the build
 * mechanically in {@link validatePlan}.
 */
export async function planFromSpec(
  spec: TomlSpec,
  options: { apiHint?: string | null; chat: ChatClient },
): Promise<TestPlan> {
  const { apiHint = null, chat } = options;
  const configured = chat.withInstructions(SPEC_PLANNER_INSTRUCTIONS).withSchema(TestPlanSchema);
  const prompt = specPrompt(spec, apiHint);
  const message = await configured.ask(prompt);
  if (message.content === null || typeof message.content !== "object") {
    throw new Error(
      `planner model returned non-JSON content for spec ${JSON.stringify(spec.meta.featureName)}`,
    );
  }
  return TestPlanSchema.parse(message.content);
}
