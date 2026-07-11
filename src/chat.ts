/**
 * The structured-output client seam — the React twin's analogue of pyllm's
 * `Chat`.
 *
 * The planner depends only on this narrow interface, never on a concrete
 * provider, so the Provider → Protocol → Connection layering stays intact and
 * the whole pipeline is testable with an in-memory fake (no network, no keys).
 * A real implementation wraps a provider SDK (Anthropic, OpenAI, ...), sends
 * the Zod schema as a strict `json_schema` response format, and returns the
 * model's parsed JSON as `content`.
 *
 * The contract mirrors `chat.with_instructions(...).with_schema(...).ask(...)`:
 * builder methods return `this` (fluent), and `ask` runs one structured-output
 * turn returning a {@link ChatMessage} whose `content` is a parsed object when
 * the model honored the schema, or a string when it could not.
 */

import type { ZodTypeAny } from "zod";

export interface ChatMessage {
  readonly role: "assistant";
  /** Parsed JSON object when the model honored the schema; a string otherwise. */
  readonly content: unknown;
}

export interface ChatClient {
  /** Set the system instructions for the turn. Returns `this` (fluent). */
  withInstructions(instructions: string): ChatClient;
  /** Constrain the response to this Zod schema. Returns `this` (fluent). */
  withSchema(schema: ZodTypeAny): ChatClient;
  /** Run one structured-output turn. */
  ask(prompt: string): Promise<ChatMessage>;
}
