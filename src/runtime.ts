/**
 * The **runtime LLM envelope** — the request/response contract a shipped React
 * frontend and its FastAPI/pyllum backend both speak at app runtime.
 *
 * This is the runtime twin of the build-time planning contract
 * (`reactullm-pyllum.contract.json`). Where that one is about compiling tests,
 * this one is about *end users of the app* invoking LLM functionality: the
 * frontend builds a typed {@link LLMRequest}, POSTs it to whatever endpoint its
 * existing HTTP client already uses, and the backend — which validates against
 * the SAME JSON Schema emitted from these Zod types — runs one structured-output
 * turn and returns a typed {@link LLMResponse}.
 *
 * Deliberately transport-free and framework-free: no fetch, no React, no keys.
 * The plugin's job is only to make the JSON on the wire typed and identical on
 * both sides. The field descriptions reach pyllum as JSON-schema text (via
 * `zod-to-json-schema`), so they double as the interface documentation — write
 * them as instructions to the backend implementer.
 *
 * The shape mirrors the {@link ChatClient} seam (`withInstructions →
 * withSchema → ask`): `instructions` is the system prompt, `schema` is the
 * optional structured-output constraint, `input` is the user turn. Keeping one
 * mental model across build-time and runtime is intentional.
 */

import { z } from "zod";

/** JSON Schema is opaque here — we validate it is an object, not its contents. */
const JsonSchemaObject = z.record(z.unknown());

/**
 * One runtime LLM call. The frontend fills this; the backend honors it.
 *
 * A request is either free-form (no `schema` → the response is assistant text)
 * or structured (`schema` present → the response `data` is a JSON object the
 * backend constrained the model to). This is the runtime analogue of
 * `chat.withInstructions(...).withSchema(...).ask(input)`.
 */
export const LLMRequestSchema = z.object({
  task: z
    .string()
    .describe(
      "Stable identifier for what this call does, e.g. 'summarize_job' or " +
        "'extract_skills'. The backend routes/authorizes/prompts on this; it is " +
        "NOT free-form prose. Frontend and backend agree on the set of task ids.",
    ),
  instructions: z
    .string()
    .default("")
    .describe(
      "System prompt for the turn — the persona/rules the model follows. Maps " +
        "to pyllum's chat.with_instructions(...). Empty string when the backend " +
        "supplies the system prompt for this `task` itself.",
    ),
  input: z
    .string()
    .describe(
      "The user turn / content to act on (the prompt passed to ask(...)). For " +
        "structured tasks this is the source text the model reads to fill `schema`.",
    ),
  schema: JsonSchemaObject.nullable()
    .default(null)
    .describe(
      "JSON Schema constraining the response. Non-null → the backend runs a " +
        "structured-output turn and `data` must honor this schema. null → a " +
        "free-form text turn (the answer comes back in `text`). Maps to pyllum's " +
        "chat.with_schema(...).",
    ),
  variables: z
    .record(z.unknown())
    .default({})
    .describe(
      "Optional named values the backend interpolates into its prompt template " +
        "for this `task` (e.g. { locale: 'fi', tone: 'formal' }). Keep secrets " +
        "OUT of here — this travels from the browser.",
    ),
});
export type LLMRequest = z.infer<typeof LLMRequestSchema>;

/** A structured error the frontend can branch on without parsing prose. */
export const LLMErrorSchema = z.object({
  code: z
    .enum([
      "schema_violation",
      "unknown_task",
      "rate_limited",
      "provider_error",
      "invalid_request",
      "internal",
    ])
    .describe(
      "Machine-readable failure class. 'schema_violation' = the model could not " +
        "honor `schema`; 'unknown_task' = the backend has no handler for `task`.",
    ),
  message: z
    .string()
    .describe("Human-readable detail for logs/UI — not for control flow."),
});
export type LLMError = z.infer<typeof LLMErrorSchema>;

/**
 * The backend's reply. Exactly one of `data`/`text` is populated on success,
 * chosen by whether the request carried a `schema`.
 */
export const LLMResponseSchema = z.object({
  task: z
    .string()
    .describe("Echoes the request `task` so out-of-order responses are matchable."),
  ok: z
    .boolean()
    .describe(
      "true → a success payload is in `data` (structured) or `text` (free-form). " +
        "false → `error` is populated and both payload fields are null.",
    ),
  data: JsonSchemaObject.nullable()
    .default(null)
    .describe(
      "The structured result honoring the request `schema`. Non-null only when " +
        "the request carried a schema and ok=true; null otherwise.",
    ),
  text: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The free-form assistant answer. Non-null only when the request had NO " +
        "schema and ok=true; null otherwise.",
    ),
  error: LLMErrorSchema.nullable()
    .default(null)
    .describe("Populated iff ok=false; null on success."),
});
export type LLMResponse = z.infer<typeof LLMResponseSchema>;
