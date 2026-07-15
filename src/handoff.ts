/**
 * The **cross-stack handoff contract** — the bidirectional twin of the planning
 * contract.
 *
 * Where `reactullm-pyllum.contract.json` is a fixed interface (reactullm tells
 * pyllum how to fill a `TestPlan`), the handoff contract is the *product* of one
 * side's generation: the API surface the OTHER side must conform to. It flows in
 * whichever direction a given generation runs:
 *
 * - **backend-first** — pyllum/FastAPI generates first; it writes the handoff
 *   describing its endpoints, and reactullm consumes it to build a matching front.
 * - **frontend-first** — reactullm generates first; it writes the handoff
 *   describing the data the components need, and pyllum consumes it to build a
 *   matching backend.
 *
 * `direction` + `producer`/`consumer` record who conforms to whom. A `runId`
 * (the same `YYYYMMDDThhmmssZ` id used by {@link module:runs}) makes generations
 * a total order, so the consumer implements ONLY the latest completed handoff —
 * a stale or half-written one never wins because a failed build writes no marker.
 *
 * This module is pure types + Zod validation; the latest-wins bookkeeping lives
 * in {@link module:handoffStore}, which reuses the run-id machinery from `runs`.
 */

import { z } from "zod";

/** JSON Schema is opaque here — we validate it is an object, not its contents. */
const JsonSchemaObject = z.record(z.string(), z.unknown());

export const EndpointSchema = z.object({
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
    .describe("HTTP method of the endpoint."),
  path: z
    .string()
    .describe("Route path, e.g. '/api/v1/jobs' or '/api/v1/jobs/{id}'."),
  summary: z
    .string()
    .default("")
    .describe("One-line description of what the endpoint does."),
  request: JsonSchemaObject.nullable()
    .default(null)
    .describe(
      "JSON Schema of the request body/params, or null for endpoints with no body.",
    ),
  response: JsonSchemaObject.describe(
    "JSON Schema of the success response body — the shape the other side binds to.",
  ),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

export const ApiSurfaceSchema = z.object({
  entities: z
    .record(z.string(), JsonSchemaObject)
    .default({})
    .describe(
      "Named entity shapes shared across endpoints (JSON Schema per entity), " +
        "e.g. { Job: {...}, Applicant: {...} }.",
    ),
  endpoints: z
    .array(EndpointSchema)
    .describe(
      "The endpoints this generation commits to. Backend-first: what FastAPI " +
        "exposes. Frontend-first: what the components require the backend to expose.",
    ),
});
export type ApiSurface = z.infer<typeof ApiSurfaceSchema>;

export const HandoffDirection = z.enum(["backend_first", "frontend_first"]);
export type HandoffDirection = z.infer<typeof HandoffDirection>;

export const HandoffContractSchema = z.object({
  version: z.literal(1).describe("Handoff contract schema version."),
  runId: z
    .string()
    .regex(/^\d{8}T\d{6}Z(?:\.\d{3})?$/)
    .describe(
      "Sortable UTC run id (YYYYMMDDThhmmssZ). The consumer implements only the " +
        "latest completed runId.",
    ),
  completedAt: z
    .string()
    .describe("ISO-8601 instant the producing generation completed."),
  direction: HandoffDirection.describe(
    "Which side generated first this run, and therefore which side must conform.",
  ),
  producer: z
    .enum(["reactullm", "pyllum"])
    .describe("The framework that generated first and wrote this contract."),
  consumer: z
    .enum(["reactullm", "pyllum"])
    .describe("The framework that must build to match this contract."),
  feature: z.string().describe("Feature name, verbatim from the spec."),
  apiSurface: ApiSurfaceSchema,
});
export type HandoffContract = z.infer<typeof HandoffContractSchema>;