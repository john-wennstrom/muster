import { describe, expect, test } from "bun:test";
import {
  createDebuggingState,
  recordUnexpectedFailure,
  type DebuggingState,
} from "../../src/policies/debugging.ts";
import {
  appendAssessment,
  applyEarlyEscalation,
  decideRepairPath,
  isStalledRound,
  type AssessmentReading,
} from "../../src/policies/repair-progress.ts";

const at = (minute: number) => `2026-09-12T12:${String(minute % 60).padStart(2, "0")}:00.000Z`;
const stalled: AssessmentReading = { sameRootCause: 0.9, progress: 0.1, humanNeeded: 0.1 };
const moving: AssessmentReading = { sameRootCause: 0.9, progress: 0.6, humanNeeded: 0.1 };
const needsHuman: AssessmentReading = { sameRootCause: 0.9, progress: 0.1, humanNeeded: 0.9 };

function fail(state: DebuggingState): DebuggingState {
  const attempt = state.failures.length + 1;
  return recordUnexpectedFailure(state, {
    reproduction: "bun test",
    evidence: [`failure ${attempt}`],
    attemptedFix: `fix ${attempt}`,
    recordedAt: at(attempt),
  });
}

function assess(state: DebuggingState, reading: AssessmentReading): DebuggingState {
  return appendAssessment(state, { ...reading, recordId: `decision-${state.failures.length}`, recordedAt: at(state.failures.length) });
}

const fresh = (threshold: number) =>
  createDebuggingState({ runId: "run-1", taskId: "1.1", threshold, createdAt: at(0) });

/** Fails and assesses in turn, returning the state after the last assessment. */
function history(threshold: number, readings: readonly (AssessmentReading | null)[]): DebuggingState {
  let state = fresh(threshold);
  for (const reading of readings) {
    state = fail(state);
    if (reading && state.failures.length >= 2) state = assess(state, reading);
  }
  return state;
}

const latestOf = (state: DebuggingState) => state.assessments!.at(-1)!;

describe("stalled rounds", () => {
  test("a round is stalled only above 0.8 same cause and below 0.3 progress", () => {
    expect(isStalledRound({ sameRootCause: 0.9, progress: 0.1 })).toBe(true);
    expect(isStalledRound({ sameRootCause: 0.8, progress: 0.1 })).toBe(false);
    expect(isStalledRound({ sameRootCause: 0.9, progress: 0.3 })).toBe(false);
  });
});

describe("repair path", () => {
  test("two consecutive stalled rounds escalate below the threshold", () => {
    const state = history(6, [null, stalled, stalled]);
    const path = decideRepairPath(state, latestOf(state));
    expect(path.kind).toBe("escalate");
    const escalated = applyEarlyEscalation(state, {
      reason: path.kind === "escalate" ? path.reason : "",
      recordId: "decision-3",
      recordedAt: at(10),
    });
    expect(escalated.mode).toBe("systematic_debugging");
    expect(escalated.escalation).toMatchObject({ attempt: 3, recordId: "decision-3" });
    expect(escalated.threshold).toBe(6);
  });

  test("one stalled round does not escalate", () => {
    const state = history(6, [null, stalled]);
    expect(decideRepairPath(state, latestOf(state)).kind).toBe("continue");
    expect(() => applyEarlyEscalation(state, { reason: "x", recordId: null, recordedAt: at(10) })).toThrow(
      expect.objectContaining({ code: "DEBUGGING_STATE_INVALID" }),
    );
  });

  test("a stalled round followed by progress does not escalate", () => {
    const state = history(6, [null, stalled, moving]);
    expect(decideRepairPath(state, latestOf(state)).kind).toBe("continue");
    const reversed = history(6, [null, moving, stalled]);
    expect(decideRepairPath(reversed, latestOf(reversed)).kind).toBe("continue");
  });

  test("rounds that are not consecutive do not escalate", () => {
    const state = history(8, [null, stalled, null, stalled]);
    expect(decideRepairPath(state, latestOf(state)).kind).toBe("continue");
  });

  test("a human-needed assessment takes precedence over escalation", () => {
    const state = history(6, [null, stalled, needsHuman]);
    const path = decideRepairPath(state, latestOf(state));
    expect(path.kind).toBe("await_user");
    expect(path.kind === "await_user" && path.reason).toBeTruthy();
  });

  test("a human-needed assessment awaits the user even on a first assessed round", () => {
    const state = history(6, [null, needsHuman]);
    expect(decideRepairPath(state, latestOf(state)).kind).toBe("await_user");
  });

  test("at the threshold the count already decided, so nothing escalates", () => {
    const state = history(3, [null, stalled, stalled]);
    expect(state.mode).toBe("systematic_debugging");
    expect(decideRepairPath(state, latestOf(state)).kind).toBe("continue");
    expect(() => applyEarlyEscalation(state, { reason: "x", recordId: null, recordedAt: at(10) })).toThrow();
  });

  test("an assessment needs two failures and is recorded once per failure", () => {
    expect(() => assess(fail(fresh(4)), stalled)).toThrow();
    const state = history(4, [null, stalled]);
    expect(() => assess(state, stalled)).toThrow();
  });
});

/** A small deterministic generator, so a failing case can be replayed from its seed. */
function generator(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

describe("judgment can only shorten a repair loop", () => {
  /**
   * Runs one loop to the attempt where it stops: systematic debugging, or awaiting the user.
   * `enforce` lets escalation apply; otherwise transitions follow the count.
   */
  function run(seed: number, enforce: boolean) {
    const next = generator(seed);
    const threshold = 1 + Math.floor(next() * 12);
    let state = fresh(threshold);
    let systematicAt: number | null = null;
    let awaitedAt: number | null = null;
    while (state.mode === "ordinary_repair") {
      state = fail(state);
      const attempted = next() < 0.85;
      if (state.failures.length >= 2 && attempted) {
        const pick = (): number => {
          const roll = next();
          return roll < 0.4 ? 0.95 * next() * 0.1 + 0.9 : roll < 0.7 ? next() * 0.25 : next();
        };
        const reading: AssessmentReading = {
          sameRootCause: pick(),
          progress: next() < 0.6 ? next() * 0.25 : next(),
          humanNeeded: next() < 0.05 ? 0.9 : next() * 0.5,
        };
        state = assess(state, reading);
        const path = decideRepairPath(state, latestOf(state));
        if (path.kind === "await_user" && enforce) {
          awaitedAt = state.failures.length;
          break;
        }
        if (path.kind === "escalate" && enforce) {
          state = applyEarlyEscalation(state, { reason: path.reason, recordId: null, recordedAt: at(59) });
        }
      }
      if (state.failures.length > threshold) throw new Error("loop overran its threshold");
    }
    if (state.mode === "systematic_debugging") systematicAt = state.failures.length;
    return { threshold, state, systematicAt, awaitedAt };
  }

  test("the attempt at which the mode becomes systematic is never later than the count-based attempt", () => {
    let escalatedEarly = 0;
    for (let seed = 1; seed <= 4_000; seed += 1) {
      const { threshold, state, systematicAt, awaitedAt } = run(seed, true);
      expect(state.threshold).toBe(threshold);
      if (awaitedAt !== null) {
        expect(awaitedAt).toBeLessThanOrEqual(threshold);
        continue;
      }
      expect(systematicAt).not.toBeNull();
      expect(systematicAt!).toBeLessThanOrEqual(threshold);
      if (systematicAt! < threshold) escalatedEarly += 1;
    }
    // The generator must actually exercise early escalation, or the property proves nothing.
    expect(escalatedEarly).toBeGreaterThan(50);
  });

  test("without acting on judgment the mode becomes systematic exactly at the threshold", () => {
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const { threshold, systematicAt } = run(seed, false);
      expect(systematicAt).toBe(threshold);
    }
  });

  test("steady progress never moves the task before its threshold", () => {
    for (const threshold of [1, 2, 3, 4, 5, 8]) {
      const state = history(threshold, Array.from({ length: threshold }, () => moving));
      expect(state.mode).toBe("systematic_debugging");
      expect(state.threshold).toBe(threshold);
      expect(state.escalation).toBeUndefined();
    }
  });
});
