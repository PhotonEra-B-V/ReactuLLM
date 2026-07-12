/**
 * Generate the reactullm-sdd ⇄ pyllum planning contract.
 *
 * The contract (`reactullm-pyllum.contract.json`) is the language-neutral
 * interface pyllum reads to serve as reactullm-sdd's request-mode planner: it
 * carries the planner system instructions plus the `TestPlan` JSON Schema.
 *
 * It is DERIVED from source (`src/schema.ts` + `src/planner.ts`) so it cannot
 * drift by hand. Regenerate whenever either changes, and bump `version`:
 *
 *   npm run gen:contract
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TestPlanSchema } from "../src/schema.js";
import { SPEC_PLANNER_INSTRUCTIONS } from "../src/planner.js";

/** Bump when the schema or instructions change; pyllum guards on this. */
const CONTRACT_VERSION = 1;

// Inline everything ($refStrategy: "none") and omit `name` so the TestPlan
// object schema is returned directly, not wrapped behind a $ref/definitions.
const testPlanSchema = zodToJsonSchema(TestPlanSchema, {
  target: "jsonSchema2019-09",
  $refStrategy: "none",
});
delete (testPlanSchema as { $schema?: string }).$schema; // carried at the contract root instead

const contract = {
  $schema: "https://json-schema.org/draft/2019-09/schema",
  version: CONTRACT_VERSION,
  title: "reactullm-sdd request-mode planning contract",
  description:
    "Language-neutral contract between reactullm-sdd (TypeScript; compiles a TOML " +
    "spec into a red React Testing Library suite) and pyllum (Python async LLM " +
    "framework). In request mode reactullm needs a model to fill a TestPlan via " +
    "structured output. pyllum reads THIS file, sends `planner_instructions` as " +
    "the system prompt, constrains its structured-output Chat to " +
    "`test_plan_schema`, and returns one TestPlan object. Neither repo imports " +
    "the other. GENERATED from src/schema.ts and src/planner.ts by " +
    "scripts/gen-contract.mts — do not hand-edit; regenerate and bump `version`.",
  seam: {
    role: "reactullm's ChatClient (src/chat.ts): withInstructions → withSchema → ask",
    operations: {
      with_instructions: "set the system prompt to `planner_instructions` (fluent)",
      with_schema: "constrain the response to `test_plan_schema` (fluent)",
      ask: "run one structured-output turn; return the parsed TestPlan object",
    },
    response: {
      role: "assistant",
      content:
        "A JSON object honoring test_plan_schema. When the model cannot honor " +
        "the schema, content is a string instead — reactullm treats that as an error.",
    },
  },
  planner_instructions: SPEC_PLANNER_INSTRUCTIONS,
  test_plan_schema: testPlanSchema,
  notes: [
    "reactullm enforces coverage (validatePlan) and safety (AST gate) on ITS side " +
      "after receiving this JSON. pyllum only needs to return a schema-valid " +
      "TestPlan; honoring `covers` faithfully is what makes reactullm's build pass.",
    "The given/when/then/fixture-body strings render VERBATIM into an executable " +
      "test module. Emit NO import statements inside any string — reactullm's " +
      "safety gate rejects them.",
    "JSON keys stay camelCase (testName, isAsync, edgeCase, requiredIds) — " +
      "reactullm's Zod schema expects them.",
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "reactullm-pyllum.contract.json");
writeFileSync(out, JSON.stringify(contract, null, 2) + "\n");
console.log(`Wrote ${out} (contract version ${CONTRACT_VERSION})`);