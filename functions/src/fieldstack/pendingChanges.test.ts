import { describe, it, expect, vi } from "vitest";

// Mock firebase-admin — pendingChanges.ts calls admin.firestore() at module scope
vi.mock("firebase-admin", () => ({
  default: {
    firestore: vi.fn(() => ({
      collection: vi.fn(),
      collectionGroup: vi.fn(),
      doc: vi.fn(),
      batch: vi.fn(() => ({
        update: vi.fn(),
        set: vi.fn(),
        commit: vi.fn(),
      })),
    })),
    apps: ["test"],
    initializeApp: vi.fn(),
  },
  firestore: vi.fn(() => ({
    collection: vi.fn(),
    collectionGroup: vi.fn(),
    doc: vi.fn(),
    batch: vi.fn(() => ({
      update: vi.fn(),
      set: vi.fn(),
      commit: vi.fn(),
    })),
  })),
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
  },
  Timestamp: {
    fromMillis: vi.fn((ms: number) => ({ toMillis: () => ms })),
    fromDate: vi.fn((d: Date) => ({ toMillis: () => d.getTime() })),
  },
  getFirestore: vi.fn(() => ({
    collection: vi.fn(),
    collectionGroup: vi.fn(),
    doc: vi.fn(),
  })),
}));

const mockFn = () => ({ __isMockFunction: true });
vi.mock("firebase-functions", () => ({
  default: {
    https: { onRequest: vi.fn(mockFn) },
    pubsub: {
      schedule: vi.fn(() => ({ timeZone: vi.fn(() => ({ onRun: vi.fn(mockFn) })), onRun: vi.fn(mockFn) })),
    },
    runWith: vi.fn(() => ({ https: { onRequest: vi.fn(mockFn) } })),
  },
  https: { onRequest: vi.fn(mockFn) },
  pubsub: {
    schedule: vi.fn(() => ({ timeZone: vi.fn(() => ({ onRun: vi.fn(mockFn) })), onRun: vi.fn(mockFn) })),
  },
  runWith: vi.fn(() => ({ https: { onRequest: vi.fn(mockFn) } })),
}));

vi.mock("resend", () => ({
  Resend: vi.fn(() => ({
    emails: { send: vi.fn() },
  })),
}));

describe("pendingChanges module", () => {
  it("imports without throwing", async () => {
    const mod = await import("./pendingChanges");
    expect(mod).toBeDefined();
  });

  it("exports pendingChangesApi", async () => {
    const mod = await import("./pendingChanges");
    expect(mod.pendingChangesApi).toBeDefined();
  });
});

// ─── Pure utility: shift day arithmetic ──────────────────────────────────────
// The module computes shiftDays as:
//   Math.round((requestedDate.toMillis() - originalDate.toMillis()) / (1000 * 60 * 60 * 24))
// We test the arithmetic inline since the function is inline (not exported).

describe("shiftDays arithmetic (inline logic from pendingChanges)", () => {
  function computeShiftDays(originalMs: number, requestedMs: number): number {
    return Math.round((requestedMs - originalMs) / (1000 * 60 * 60 * 24));
  }

  it("returns 0 for same date", () => {
    const now = new Date("2026-06-01").getTime();
    expect(computeShiftDays(now, now)).toBe(0);
  });

  it("returns positive value when new date is later", () => {
    const original = new Date("2026-06-01").getTime();
    const requested = new Date("2026-06-08").getTime();
    expect(computeShiftDays(original, requested)).toBe(7);
  });

  it("returns negative value when new date is earlier", () => {
    const original = new Date("2026-06-08").getTime();
    const requested = new Date("2026-06-01").getTime();
    expect(computeShiftDays(original, requested)).toBe(-7);
  });

  it("rounds partial days", () => {
    const original = new Date("2026-06-01T00:00:00.000Z").getTime();
    // 1.5 days later — rounds to 2
    const requested = original + 1.5 * 24 * 60 * 60 * 1000;
    expect(computeShiftDays(original, requested)).toBe(2);
  });
});

// ─── Pure utility: conflict status logic ──────────────────────────────────────
// When another sub already has a PENDING change for the same task the new
// request is stored as CONFLICT. We test the pure predicate.

describe("isConflict predicate (inline logic from pendingChanges POST handler)", () => {
  function isConflict(otherPendingCount: number): boolean {
    return otherPendingCount > 0;
  }

  it("no other pending requests → not a conflict", () => {
    expect(isConflict(0)).toBe(false);
  });

  it("one other pending request → conflict", () => {
    expect(isConflict(1)).toBe(true);
  });

  it("multiple other pending requests → conflict", () => {
    expect(isConflict(3)).toBe(true);
  });
});
