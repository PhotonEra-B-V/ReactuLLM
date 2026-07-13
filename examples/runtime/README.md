# Runtime LLM envelope — example

The runtime twin of the build-time planning contract. Here the app's **end
users** invoke LLM functionality: the frontend builds a typed `LLMRequest`, sends
it over its own HTTP client to a FastAPI/pyllum backend, and gets back a typed
`LLMResponse`. Neither side imports the other — the only coupling is the
generated JSON Schema, [`../../reactullm-pyllum.runtime.json`](../../reactullm-pyllum.runtime.json).

- **Frontend:** [`summarize_job.ts`](summarize_job.ts) — a one-line `postLLM`
  transport adapter plus two calls: a free-form task (`summarizeJob`, answer in
  `response.text`) and a structured task (`extractSkills`, answer in
  `response.data` honoring a JSON Schema).
- **Backend:** see [`../../PYLLUM_RUNTIME_PROMPT.md`](../../PYLLUM_RUNTIME_PROMPT.md)
  for the handler brief that answers these requests.

Regenerate the contract after editing `src/runtime.ts`:

```bash
npm run gen:runtime
```
