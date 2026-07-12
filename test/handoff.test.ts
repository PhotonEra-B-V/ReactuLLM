/**
 * The cross-stack handoff contract: latest-wins bookkeeping and the env switch.
 *
 * Proves the invariants your two questions asked for:
 * - generation flows BOTH ways (backend_first / frontend_first) through one file;
 * - only the LATEST committed generation is implemented (runId total order);
 * - same-second commits de-collide; the env var is the on/off switch.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  commitHandoff,
  HANDOFF_CONTRACT_FILENAME,
  HANDOFF_DONE_FILENAME,
  type HandoffContract,
  handoffDir,
  isNewerThanImplemented,
  latestHandoff,
} from "../src/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "handoff-"));
}

const backendFirst: Omit<HandoffContract, "runId" | "completedAt"> = {
  version: 1,
  direction: "backend_first",
  producer: "pyllum",
  consumer: "reactullm",
  feature: "Job search",
  apiSurface: {
    entities: { Job: { type: "object", properties: { id: { type: "string" } } } },
    endpoints: [
      {
        method: "GET",
        path: "/api/v1/jobs",
        summary: "list jobs",
        request: null,
        response: { type: "array", items: { $ref: "#/entities/Job" } },
      },
    ],
  },
};

const frontendFirst: Omit<HandoffContract, "runId" | "completedAt"> = {
  ...backendFirst,
  direction: "frontend_first",
  producer: "reactullm",
  consumer: "pyllum",
};

const at = (iso: string) => (): Date => new Date(iso);

describe("handoff env switch", () => {
  it("is off when the env var is unset or blank", () => {
    expect(handoffDir({})).toBeNull();
    expect(handoffDir({ REACTULLM_PYLLUM_HANDOFF_DIR: "  " })).toBeNull();
  });

  it("resolves the shared dir when set", () => {
    expect(handoffDir({ REACTULLM_PYLLUM_HANDOFF_DIR: "/shared/h" })).toBe("/shared/h");
  });
});

describe("handoff commit + latest-wins", () => {
  it("writes the contract, marker, and a flat contract file", () => {
    const dir = tmp();
    const rec = commitHandoff(dir, backendFirst, { now: at("2026-07-13T10:00:00Z") });
    expect(rec.runId).toBe("20260713T100000Z");
    expect(existsSync(join(dir, HANDOFF_DONE_FILENAME))).toBe(true);
    const flat = JSON.parse(readFileSync(join(dir, HANDOFF_CONTRACT_FILENAME), "utf-8"));
    expect(flat.direction).toBe("backend_first");
    expect(latestHandoff(dir)?.runId).toBe(rec.runId);
  });

  it("carries direction both ways in one timeline", () => {
    const dir = tmp();
    commitHandoff(dir, backendFirst, { now: at("2026-07-13T10:00:00Z") });
    const second = commitHandoff(dir, frontendFirst, { now: at("2026-07-13T11:00:00Z") });
    const latest = latestHandoff(dir)!;
    expect(latest.runId).toBe(second.runId);
    expect(latest.direction).toBe("frontend_first");
    expect(latest.producer).toBe("reactullm");
  });

  it("de-collides same-second commits so latest is unambiguous", () => {
    const dir = tmp();
    const a = commitHandoff(dir, backendFirst, { now: at("2026-07-13T10:00:00Z") });
    const b = commitHandoff(dir, frontendFirst, { now: at("2026-07-13T10:00:00Z") });
    expect(a.runId).toBe("20260713T100000Z");
    expect(b.runId).toBe("20260713T100000Z.002");
    expect(latestHandoff(dir)!.runId).toBe(b.runId);
  });
});

describe("only the latest generation is implemented", () => {
  it("is newer only when it sorts strictly after the last implemented run", () => {
    const dir = tmp();
    expect(isNewerThanImplemented(dir, null)).toBe(false); // nothing committed yet

    const first = commitHandoff(dir, backendFirst, { now: at("2026-07-13T10:00:00Z") });
    expect(isNewerThanImplemented(dir, null)).toBe(true); // never implemented → build it
    expect(isNewerThanImplemented(dir, first.runId)).toBe(false); // already up to date

    const second = commitHandoff(dir, frontendFirst, { now: at("2026-07-13T12:00:00Z") });
    expect(isNewerThanImplemented(dir, first.runId)).toBe(true); // newer arrived
    expect(isNewerThanImplemented(dir, second.runId)).toBe(false); // caught up again
  });
});