/**
 * Runtime LLM envelope — frontend side, end to end.
 *
 * Shows the two shapes a shipped React app sends its FastAPI/pyllum backend:
 * a free-form task (answer comes back in `text`) and a structured task (answer
 * comes back in `data`, honoring a JSON Schema). No transport lives here — the
 * envelope rides on whatever HTTP client the app already has; `postLLM` is a
 * one-line adapter you write once.
 *
 * The types come straight from the plugin, so the object you build is checked
 * against the same source the backend validates against
 * (`reactullm-pyllum.runtime.json`). See PYLLUM_RUNTIME_PROMPT.md for the
 * handler that answers these.
 */

import {
  type LLMRequest,
  type LLMResponse,
  LLMRequestSchema,
  LLMResponseSchema,
} from "reactullm-sdd";

/**
 * The only transport code — swap `fetch` for your app's client (axios, ky, an
 * RTK-Query endpoint, …). It validates on the way out and in so a shape drift
 * fails loudly at the boundary, not deep in a component.
 */
export async function postLLM(req: LLMRequest): Promise<LLMResponse> {
  const body = LLMRequestSchema.parse(req); // fills defaults, rejects bad shapes
  const res = await fetch("/api/v1/llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return LLMResponseSchema.parse(await res.json());
}

/** Free-form task: no `schema`, so the answer arrives in `response.text`. */
export async function summarizeJob(description: string, locale = "en"): Promise<string> {
  const res = await postLLM({
    task: "summarize_job",
    input: description,
    variables: { locale },
  });
  if (!res.ok) throw new Error(`${res.error?.code}: ${res.error?.message}`);
  return res.text ?? "";
}

/**
 * Structured task: attach a JSON Schema, so the answer arrives in
 * `response.data` shaped exactly like it. The backend constrained the model to
 * this schema — the frontend just declares the shape it wants.
 */
export interface ExtractedSkills {
  skills: string[];
  yearsExperience: number;
}

export async function extractSkills(resumeText: string): Promise<ExtractedSkills> {
  const res = await postLLM({
    task: "extract_skills",
    input: resumeText,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["skills", "yearsExperience"],
      properties: {
        skills: { type: "array", items: { type: "string" } },
        yearsExperience: { type: "number" },
      },
    },
  });
  if (!res.ok) throw new Error(`${res.error?.code}: ${res.error?.message}`);
  return res.data as unknown as ExtractedSkills;
}
