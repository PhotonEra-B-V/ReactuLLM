/**
 * Test fixtures for the SDD framework's own suite — the conftest analogue.
 *
 * `FakeChat` is an in-memory {@link ChatClient} that records every `ask` and
 * returns a canned response, so request-mode tests exercise the planner with no
 * network and no keys — the twin of the Python suite's `mock_http` +
 * `sent_requests`.
 */

import type { ZodTypeAny } from "zod";

import type { ChatClient, ChatMessage } from "../src/chat.js";
import { type TestPlan } from "../src/schema.js";

export class FakeChat implements ChatClient {
  readonly prompts: string[] = [];
  instructions: string | null = null;
  schema: ZodTypeAny | null = null;

  constructor(private readonly response: unknown) {}

  withInstructions(instructions: string): ChatClient {
    this.instructions = instructions;
    return this;
  }

  withSchema(schema: ZodTypeAny): ChatClient {
    this.schema = schema;
    return this;
  }

  async ask(prompt: string): Promise<ChatMessage> {
    this.prompts.push(prompt);
    return { role: "assistant", content: this.response };
  }
}

/** A plan the fake planner returns; deliberately covers NO rule/edge/M ids. */
export function samplePlan(): TestPlan {
  return {
    feature: "Use debounce",
    api: {
      module: "@/hooks/useDebounce",
      imports: ["import { useDebounce } from '@/hooks/useDebounce'"],
      signatures: ["export function useDebounce<T>(value: T, delayMs: number): T"],
    },
    fixtures: [],
    cases: [
      {
        scenario: "Initial value",
        testName: "returns the initial value on first render",
        given: ["const { result } = renderHook(() => useDebounce('a', 200));"],
        when: "None",
        then: ["expect(result.current).toBe('a')"],
        fixtures: [],
        covers: [],
        isAsync: false,
        edgeCase: false,
        notes: "",
      },
    ],
    requiredIds: [],
  };
}
