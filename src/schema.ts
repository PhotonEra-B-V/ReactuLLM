/**
 * The structured contract the planner LLM fills in.
 *
 * The model never writes freeform test code — it fills {@link TestPlan}, and
 * the renderer turns that into Vitest + React Testing Library source
 * deterministically. Field descriptions reach the provider as part of the JSON
 * schema (via `zod-to-json-schema` at the call site), so they double as prompt
 * instructions — write them AS instructions to the model.
 *
 * This is the React/TypeScript twin of `pyllm.bdd.schema`. The shapes are
 * one-to-one — `ApiSurface`, `FixtureDef`, `TestCase`, `TestPlan` — but every
 * field is re-specified for a React world: the module under test is a
 * component/hook file, `given` is render/props/mock arrangement, `when` is a
 * single user-event interaction or a hook call under `renderHook`, and each
 * `then` is a complete RTL assertion statement.
 */

import { z } from "zod";

/** The public API the tests exercise — this is the design commitment. */
export const ApiSurfaceSchema = z.object({
  module: z
    .string()
    .describe(
      "Import path of the component/hook module under test, relative to the " +
        "test file or an alias, e.g. '@/components/SearchBox' or './useDebounce'",
    ),
  imports: z
    .array(z.string())
    .default([])
    .describe(
      "Exact import statements the test file needs beyond the RTL harness, " +
        "e.g. \"import { SearchBox } from '@/components/SearchBox'\" or " +
        "\"import { useDebounce } from '@/hooks/useDebounce'\". Do not import " +
        "render/screen/userEvent/renderHook — the harness provides those.",
    ),
  signatures: z
    .array(z.string())
    .describe(
      "Public component/hook/function signatures to implement, as TypeScript " +
        "type lines, e.g. " +
        "'export function SearchBox(props: { onSearch: (q: string) => void; delayMs?: number }): JSX.Element' " +
        "or 'export function useDebounce<T>(value: T, delayMs: number): T'",
    ),
});
export type ApiSurface = z.infer<typeof ApiSurfaceSchema>;

export const FixtureDefSchema = z.object({
  name: z
    .string()
    .describe(
      "Valid camelCase JS identifier for the setup helper (a factory returning " +
        "props, a mock, a store, or a wrapper)",
    ),
  body: z
    .array(z.string())
    .describe(
      "Executable statements for the helper body; the last must be a 'return'. " +
        "Rendered as a function the test calls, e.g. 'return { onSearch: jest.fn() }'.",
    ),
});
export type FixtureDef = z.infer<typeof FixtureDefSchema>;

export const TestCaseSchema = z.object({
  scenario: z.string().describe("Name of the scenario this case comes from"),
  testName: z
    .string()
    .describe(
      "Human-readable test title for `it(...)`, e.g. 'disables the button while loading'",
    ),
  given: z
    .array(z.string())
    .default([])
    .describe(
      "Arrange statements — executable TypeScript, one statement per entry. " +
        "Set up props/mocks/store/router and RENDER the component " +
        "(e.g. 'const onSearch = vi.fn()', " +
        "\"render(<SearchBox onSearch={onSearch} />)\"). For a hook, render it " +
        "with 'const { result } = renderHook(() => useThing(...))'. Request a " +
        "fixture by calling it here (e.g. 'const props = makeProps()').",
    ),
  when: z
    .string()
    .describe(
      "The SINGLE act, as an expression; its value is assigned to `result`. " +
        "For a component this is a user interaction via userEvent (e.g. " +
        "\"userEvent.type(screen.getByRole('textbox'), 'hello')\") — include " +
        "'await'. For a hook it is the call whose value you assert, wrapped in " +
        "act if it mutates (e.g. 'act(() => result.current.increment())'). When " +
        "the arrange step already rendered and the assertion needs no distinct " +
        "act (pure render assertion), set this to 'None'.",
    ),
  then: z
    .array(z.string())
    .describe(
      "Complete React Testing Library assertion STATEMENTS, each a full line " +
        "including the expect(...) wrapper, e.g. " +
        "\"expect(screen.getByRole('button')).toBeDisabled()\" or " +
        "'expect(onSearch).toHaveBeenCalledWith(\"hello\")' or " +
        "'expect(result.current).toBe(0)'. jest-dom matchers (toBeDisabled, " +
        "toBeInTheDocument, ...) are available. Do NOT prefix with 'assert'; " +
        "write the assertion exactly as it appears in the test body.",
    ),
  fixtures: z
    .array(z.string())
    .default([])
    .describe(
      "Names of setup helpers this test uses (each is emitted as a callable " +
        "helper; invoke them inside 'given')",
    ),
  covers: z
    .array(z.string())
    .default([])
    .describe(
      "Ids this test exercises: sequence-diagram message ids (e.g. 'M1') " +
        "and/or rule/edge-case ids (e.g. 'rule_1', 'edge_1'); required when the " +
        "feature has sequence diagrams, rules, or edge cases",
    ),
  isAsync: z
    .boolean()
    .default(true)
    .describe(
      "True when the act or arrange steps need await (userEvent and most RTL " +
        "flows are async — default true; set false only for a pure synchronous " +
        "hook/render assertion)",
    ),
  edgeCase: z
    .boolean()
    .default(false)
    .describe(
      "True when this case was derived beyond the literal scenarios (boundary, " +
        "error path, empty/loading state)",
    ),
  notes: z
    .string()
    .default("")
    .describe("One line of implementer-facing context, if useful"),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestPlanSchema = z.object({
  feature: z.string().describe("The feature name, verbatim from the spec"),
  api: ApiSurfaceSchema,
  fixtures: z.array(FixtureDefSchema).default([]),
  cases: z.array(TestCaseSchema),
  requiredIds: z
    .array(z.string())
    .default([])
    .describe(
      "Rule and edge-case ids (e.g. 'rule_1', 'edge_1') that every sound plan " +
        "MUST cover via some TestCase.covers entry",
    ),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;
