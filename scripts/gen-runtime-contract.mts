/**
 * Generate the reactullm-sdd ⇄ pyllum RUNTIME contract.
 *
 * Where `reactullm-pyllum.contract.json` is the build-time planning interface,
 * `reactullm-pyllum.runtime.json` is the runtime one: the request/response
 * envelope a shipped React frontend and its FastAPI/pyllum backend both speak
 * when the app's end users invoke LLM functionality. The frontend builds an
 * `LLMRequest`, POSTs it to whatever endpoint it already uses, and the backend
 * validates against the SAME JSON Schema emitted here and replies with an
 * `LLMResponse`. Neither repo imports the other.
 *
 * DERIVED from `src/runtime.ts` so it cannot drift by hand. Regenerate whenever
 * the envelope changes, and bump `version`:
 *
 *   npm run gen:runtime
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LLMRequestSchema, LLMResponseSchema } from "../src/runtime.js";

/** Bump when either envelope schema changes; pyllum guards on this. */
const CONTRACT_VERSION = 1;

const toSchema = (schema: Parameters<typeof zodToJsonSchema>[0]) => {
  const json = zodToJsonSchema(schema, {
    target: "jsonSchema2019-09",
    $refStrategy: "none",
  });
  delete (json as { $schema?: string }).$schema; // carried at the contract root
  return json;
};

const contract = {
  $schema: "https://json-schema.org/draft/2019-09/schema",
  version: CONTRACT_VERSION,
  title: "reactullm-sdd ⇄ pyllum runtime LLM contract",
  description:
    "Language-neutral RUNTIME contract between a React frontend (using the " +
    "reactullm-sdd runtime envelope) and a FastAPI/pyllum backend. Unlike the " +
    "build-time planning contract, this governs LLM calls made by the app's end " +
    "users: the frontend POSTs a request honoring `request_schema` to whatever " +
    "endpoint it already uses; the backend validates against that same schema, " +
    "runs one (optionally structured-output) turn via pyllum, and replies with a " +
    "response honoring `response_schema`. Neither repo imports the other. " +
    "GENERATED from src/runtime.ts by scripts/gen-runtime-contract.mts — do not " +
    "hand-edit; regenerate and bump `version`.",
  seam: {
    role: "transport-free JSON envelope; the frontend's existing HTTP client carries it",
    operations: {
      request: "frontend builds an LLMRequest (task, instructions, input, optional schema)",
      dispatch:
        "backend routes on `task`, sets the system prompt to `instructions`, and " +
        "constrains its pyllum Chat to `schema` when present",
      response:
        "backend returns an LLMResponse: `data` (schema honored) or `text` " +
        "(free-form) on ok=true, else a structured `error`",
    },
  },
  request_schema: toSchema(LLMRequestSchema),
  response_schema: toSchema(LLMResponseSchema),
  notes: [
    "A request with schema=null is a free-form turn → the answer comes back in " +
      "response.text. A request with a non-null schema is structured → the answer " +
      "comes back in response.data honoring that schema.",
    "`task` is a stable id both sides agree on; the backend authorizes/prompts on " +
      "it. It is not free-form prose and is echoed back on the response for matching.",
    "This envelope carries from the browser — keep secrets and API keys server-side; " +
      "never place them in `variables`.",
    "JSON keys stay camelCase to match the Zod source; a Python backend can alias " +
      "them (e.g. pydantic populate_by_name) without changing the wire shape.",
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "reactullm-pyllum.runtime.json");
writeFileSync(out, JSON.stringify(contract, null, 2) + "\n");
console.log(`Wrote ${out} (runtime contract version ${CONTRACT_VERSION})`);
