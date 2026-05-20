import { describe, it, expect, vi } from "vitest";

// Mock firebase-admin — magicLink.ts calls admin.firestore() at module scope
vi.mock("firebase-admin", () => ({
  default: {
    firestore: vi.fn(() => ({
      collectionGroup: vi.fn(),
      doc: vi.fn(),
    })),
    apps: ["test"],
    initializeApp: vi.fn(),
  },
  firestore: vi.fn(() => ({
    collectionGroup: vi.fn(),
    doc: vi.fn(),
  })),
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
  },
  getFirestore: vi.fn(() => ({
    collectionGroup: vi.fn(),
    doc: vi.fn(),
  })),
}));

vi.mock("firebase-functions", () => ({
  default: {
    https: {
      onRequest: vi.fn(),
    },
  },
  https: {
    onRequest: vi.fn(),
  },
}));

import { createMagicToken, buildMagicUrl } from "./magicLink";

describe("createMagicToken", () => {
  it("returns a non-empty string", () => {
    const token = createMagicToken({
      stepId: "step-001",
      action: "complete",
      ownerCompanyId: "company-xyz",
    });
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("contains exactly one '.' separator (data.signature format)", () => {
    const token = createMagicToken({
      stepId: "step-001",
      action: "complete",
      ownerCompanyId: "company-xyz",
    });
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    // Both parts should be non-empty base64url strings
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("encodes the provided stepId in the payload", () => {
    const token = createMagicToken({
      stepId: "my-unique-step",
      action: "complete",
      ownerCompanyId: "co-1",
    });
    // The first part is base64url-encoded JSON; decode and inspect it
    const [data] = token.split(".");
    const decoded = JSON.parse(Buffer.from(data, "base64url").toString());
    expect(decoded.stepId).toBe("my-unique-step");
  });

  it("encodes the action and ownerCompanyId in the payload", () => {
    const token = createMagicToken({
      stepId: "s-1",
      action: "block",
      ownerCompanyId: "co-block",
    });
    const [data] = token.split(".");
    const decoded = JSON.parse(Buffer.from(data, "base64url").toString());
    expect(decoded.action).toBe("block");
    expect(decoded.ownerCompanyId).toBe("co-block");
  });

  it("includes an expiry timestamp in the future", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = createMagicToken({
      stepId: "s-2",
      action: "complete",
      ownerCompanyId: "co-2",
    });
    const [data] = token.split(".");
    const decoded = JSON.parse(Buffer.from(data, "base64url").toString());
    expect(decoded.exp).toBeGreaterThan(before);
  });

  it("produces different tokens for different stepIds", () => {
    const t1 = createMagicToken({ stepId: "aaa", action: "complete", ownerCompanyId: "co" });
    const t2 = createMagicToken({ stepId: "bbb", action: "complete", ownerCompanyId: "co" });
    expect(t1).not.toBe(t2);
  });
});

describe("buildMagicUrl", () => {
  it("returns a string containing the token", () => {
    const token = "somedata.somesig";
    const url = buildMagicUrl(token);
    expect(url).toContain(token);
  });

  it("returns a string that contains '/tasks/action'", () => {
    const url = buildMagicUrl("data.sig");
    expect(url).toContain("/tasks/action");
  });

  it("includes the token as a query parameter", () => {
    const token = "mydata.mysig";
    const url = buildMagicUrl(token);
    expect(url).toContain(`token=${token}`);
  });
});

describe("createMagicToken + buildMagicUrl round-trip", () => {
  it("produces a URL that contains the full token", () => {
    const token = createMagicToken({
      stepId: "round-trip-step",
      action: "complete",
      ownerCompanyId: "co-round",
    });
    const url = buildMagicUrl(token);

    // The token (both parts) should appear in the URL
    expect(url).toContain(token);
    // The URL should look like a valid http/https URL
    expect(url).toMatch(/^https?:\/\//);
  });
});
