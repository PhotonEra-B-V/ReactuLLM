/**
 * Timestamped generation runs: a completion marker and an append-only history
 * log, so a later generation can tell which run is the latest and whether it
 * finished cleanly.
 *
 * Two files live in the output directory alongside the artifacts:
 *
 * - **`DONE.json`** — the completion marker for the most recent *successful*
 *   run. It is written ONLY after the safety and coverage gates pass and every
 *   artifact is on disk, so its mere presence (and matching `runId`) means the
 *   run completed. A build that throws never writes it — a half-written or
 *   failed generation is therefore detectable: no `DONE.json`, or a `DONE.json`
 *   whose `runId` is older than the newest manifest entry.
 * - **`.sdd-runs.json`** — an append-only history of every completed run
 *   (newest last), for auditing and for resolving "the latest run" without
 *   re-scanning the tree.
 *
 * A `runId` is a UTC timestamp `YYYYMMDDThhmmssZ` — lexically sortable, so
 * "latest" is just the max. Per the design decision, runs are NOT cross-checked
 * against each other: each is validated only against its own spec. This module
 * only records *when* and *what* was generated; it does not gate on history.
 *
 * The clock is injectable (`now`) so builds are deterministic and testable —
 * the same discipline the Python pipeline used to keep timestamps out of the
 * hot path.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DONE_FILENAME = "DONE.json";
export const MANIFEST_FILENAME = ".sdd-runs.json";

/** Metadata for a single spec's artifacts within a run. */
export interface RunSpecEntry {
  readonly feature: string;
  readonly slug: string;
  readonly mode: "plan" | "request";
  readonly caseCount: number;
  /** Files written for this spec, relative to the output directory. */
  readonly files: readonly string[];
  /** Coverage sets claimed as satisfied, for the record (not cross-checked). */
  readonly coveredScenarios: readonly string[];
  readonly coveredIds: readonly string[];
}

/** The completion marker / one history entry. */
export interface RunRecord {
  /** UTC timestamp id, `YYYYMMDDThhmmssZ` — lexically sortable. */
  readonly runId: string;
  /** ISO-8601 instant the run completed. */
  readonly completedAt: string;
  /** Tool identifier + version that produced the run. */
  readonly tool: string;
  readonly specs: readonly RunSpecEntry[];
}

export interface Manifest {
  /** Append-only, oldest first. The last entry is the latest completed run. */
  readonly runs: readonly RunRecord[];
}

/** Format a `Date` as a sortable UTC run id: `YYYYMMDDThhmmssZ`. */
export function toRunId(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** Read the run manifest, or an empty one when absent/unreadable. */
export function readManifest(outDir: string): Manifest {
  const path = join(outDir, MANIFEST_FILENAME);
  if (!existsSync(path)) return { runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Manifest;
    return Array.isArray(parsed.runs) ? parsed : { runs: [] };
  } catch {
    // A corrupt manifest must not wedge generation; treat as empty history.
    return { runs: [] };
  }
}

/**
 * Read the completion marker, or `null` when the output directory has no
 * completed run yet.
 */
export function readDone(outDir: string): RunRecord | null {
  const path = join(outDir, DONE_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RunRecord;
  } catch {
    return null;
  }
}

/**
 * The latest completed run for an output directory, or `null` if none.
 *
 * Prefers the marker (`DONE.json`) but falls back to the newest manifest entry;
 * if both exist, the lexically-greater `runId` wins (so a `DONE.json` left over
 * from an interrupted write never shadows a newer recorded run).
 */
export function latestRun(outDir: string): RunRecord | null {
  const done = readDone(outDir);
  const runs = readManifest(outDir).runs;
  const newest = runs.length ? runs[runs.length - 1]! : null;
  if (done && newest) return done.runId >= newest.runId ? done : newest;
  return done ?? newest;
}

/**
 * Ensure `runId` sorts strictly after every id already recorded.
 *
 * Run ids are second-granularity, so two generations in the same second (or a
 * clock that went backwards) would otherwise collide or sort behind history and
 * make "latest" ambiguous. When the incoming id doesn't already sort strictly
 * after the newest recorded id, we disambiguate off the NEWEST id — not the
 * stale incoming one — by appending / bumping a `.NNN` suffix. Anchoring on the
 * newest guarantees the result exceeds it (a `.NNN` suffix on an older prefix
 * never could), so the sequence stays a total order and the loop terminates.
 */
export function uniqueRunId(runId: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  const newest = existing.reduce((max, id) => (id > max ? id : max), "");
  if (runId > newest && !taken.has(runId)) return runId;

  // Base the disambiguator on whichever is greater: the incoming id or history.
  const base = runId > newest ? runId : newest;
  // If `base` already carries a `.NNN` suffix, strip it and continue numbering.
  const match = /^(.*Z)(?:\.(\d+))?$/.exec(base);
  const stem = match ? match[1]! : base;
  let n = match && match[2] ? Number.parseInt(match[2], 10) + 1 : 2;
  let candidate = `${stem}.${String(n).padStart(3, "0")}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${stem}.${String(n).padStart(3, "0")}`;
  }
  return candidate;
}

/**
 * Commit a completed run: append it to the manifest and (over)write the
 * `DONE.json` marker.
 *
 * Call this ONLY after every gate has passed and every artifact is on disk —
 * its presence is the signal that the generation finished. The run id is
 * de-collided against history ({@link uniqueRunId}) so same-second regenerations
 * stay uniquely ordered; the possibly-adjusted record is returned.
 */
export function commitRun(outDir: string, record: RunRecord): RunRecord {
  const manifest = readManifest(outDir);
  const runId = uniqueRunId(record.runId, manifest.runs.map((r) => r.runId));
  const committed: RunRecord = runId === record.runId ? record : { ...record, runId };
  const next: Manifest = { runs: [...manifest.runs, committed] };
  writeFileSync(join(outDir, MANIFEST_FILENAME), JSON.stringify(next, null, 2) + "\n", "utf-8");
  writeFileSync(join(outDir, DONE_FILENAME), JSON.stringify(committed, null, 2) + "\n", "utf-8");
  return committed;
}
