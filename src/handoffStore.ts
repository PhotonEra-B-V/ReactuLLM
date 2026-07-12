/**
 * Latest-wins bookkeeping for the cross-stack {@link HandoffContract}.
 *
 * A handoff directory (shared between the two repos, located via the
 * `REACTULLM_PYLLUM_HANDOFF_DIR` env var) holds three files, mirroring the
 * test-suite run bookkeeping in {@link module:runs} but kept SEPARATE so the two
 * histories never collide:
 *
 * - `handoff.contract.json` — the latest handoff contract (overwritten each run).
 * - `HANDOFF_DONE.json`      — completion marker for the latest *committed* run.
 * - `.handoff-runs.json`     — append-only history (oldest first).
 *
 * The direction is recorded in the contract itself, so backend-first and
 * frontend-first generations interleave in one timeline. "Only the latest
 * generation is implemented" is enforced by {@link isNewerThanImplemented}:
 * a consumer implements a handoff only when its `runId` sorts strictly after the
 * last one it built. A failed producer build writes no marker, so a half-written
 * handoff never becomes "latest".
 *
 * Run ids come from {@link module:runs} (`toRunId` / `uniqueRunId`) — the exact
 * same `YYYYMMDDThhmmssZ` scheme both pipelines already use.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HandoffContract, HandoffContractSchema } from "./handoff.js";
import { toRunId, uniqueRunId } from "./runs.js";

export const HANDOFF_CONTRACT_FILENAME = "handoff.contract.json";
export const HANDOFF_DONE_FILENAME = "HANDOFF_DONE.json";
export const HANDOFF_MANIFEST_FILENAME = ".handoff-runs.json";

/** The env var that both switches the connection on and locates the shared dir. */
export const HANDOFF_DIR_ENV = "REACTULLM_PYLLUM_HANDOFF_DIR";

interface HandoffManifest {
  readonly runs: readonly HandoffContract[];
}

/**
 * Resolve the shared handoff directory from the environment, or `null` when the
 * connection is off. Unset env var = handoff disabled (no error) — the same
 * switch discipline as the planning contract.
 */
export function handoffDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env[HANDOFF_DIR_ENV];
  return dir && dir.trim() ? dir : null;
}

function readManifest(dir: string): HandoffManifest {
  const path = join(dir, HANDOFF_MANIFEST_FILENAME);
  if (!existsSync(path)) return { runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as HandoffManifest;
    return Array.isArray(parsed.runs) ? parsed : { runs: [] };
  } catch {
    return { runs: [] };
  }
}

/** The latest committed handoff contract, or `null` if none / unreadable. */
export function latestHandoff(dir: string): HandoffContract | null {
  const donePath = join(dir, HANDOFF_DONE_FILENAME);
  const done = existsSync(donePath)
    ? safeParse(readFileSync(donePath, "utf-8"))
    : null;
  const runs = readManifest(dir).runs;
  const newest = runs.length ? runs[runs.length - 1]! : null;
  if (done && newest) return done.runId >= newest.runId ? done : newest;
  return done ?? newest;
}

function safeParse(raw: string): HandoffContract | null {
  try {
    return HandoffContractSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Has a newer handoff arrived than the one the caller last implemented?
 *
 * `lastImplementedRunId` is the runId the consumer built against previously
 * (`null` if it has never implemented one). Returns true only when the latest
 * committed handoff sorts strictly after it — so re-running a consumer that is
 * already up to date is a no-op, and stale contracts are never re-implemented.
 */
export function isNewerThanImplemented(
  dir: string,
  lastImplementedRunId: string | null,
): boolean {
  const latest = latestHandoff(dir);
  if (!latest) return false;
  return lastImplementedRunId === null || latest.runId > lastImplementedRunId;
}

/**
 * Commit a handoff contract: assign a de-collided run id, append to history, and
 * (over)write the marker + the flat `handoff.contract.json`.
 *
 * Call ONLY after the producing generation has fully succeeded — the marker's
 * presence is the "this handoff is real" signal. `now` is injectable for
 * deterministic tests, matching the discipline in {@link module:runs}.
 */
export function commitHandoff(
  dir: string,
  contract: Omit<HandoffContract, "runId" | "completedAt">,
  opts: { now?: () => Date; runId?: string } = {},
): HandoffContract {
  mkdirSync(dir, { recursive: true });
  const now = opts.now ?? ((): Date => new Date());
  const at = now();
  const manifest = readManifest(dir);
  const runId = uniqueRunId(
    opts.runId ?? toRunId(at),
    manifest.runs.map((r) => r.runId),
  );
  const committed: HandoffContract = HandoffContractSchema.parse({
    ...contract,
    runId,
    completedAt: at.toISOString(),
  });

  const nextManifest: HandoffManifest = { runs: [...manifest.runs, committed] };
  const body = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";
  writeFileSync(join(dir, HANDOFF_MANIFEST_FILENAME), body(nextManifest), "utf-8");
  writeFileSync(join(dir, HANDOFF_DONE_FILENAME), body(committed), "utf-8");
  writeFileSync(join(dir, HANDOFF_CONTRACT_FILENAME), body(committed), "utf-8");
  return committed;
}