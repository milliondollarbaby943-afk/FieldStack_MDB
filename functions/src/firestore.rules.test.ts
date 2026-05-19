/**
 * Firestore Security Rules tests for GC/Sub access isolation.
 *
 * Requires the Firestore emulator to be running on port 8080.
 * Run via: npm run test:rules
 * (This file is excluded from the default `npm test` run which does not start the emulator.)
 *
 * Key invariants tested:
 *   - Sub users can only read tasks assigned to their company
 *   - Sub users can only write status/notes on taskSteps where canEditBy permits
 *   - Sub users cannot access projects without an active connection
 *   - GC users retain full read access on their own company's data
 *   - Unauthenticated users cannot read any data
 */

import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import path from "path";

const RULES_PATH = path.resolve(__dirname, "../../firestore.rules");

let testEnv: RulesTestEnvironment;

// ── IDs used across all tests ────────────────────────────────────────────────

const GC_COMPANY = "gc-company-1";
const SUB_COMPANY = "sub-company-1";
const OTHER_SUB_COMPANY = "sub-company-2";
const GC_PROJECT = "project-1";
const UNCONNECTED_PROJECT = "project-2";
const GC_USER = "gc-user-1";
const SUB_USER = "sub-user-1";
const OTHER_SUB_USER = "sub-user-2";

// ── Environment setup ─────────────────────────────────────────────────────────

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "test-project",
    firestore: {
      rules: readFileSync(RULES_PATH, "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();

  // Seed all test data with security rules bypassed
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    // Companies
    await db.doc(`companies/${GC_COMPANY}`).set({
      id: GC_COMPANY,
      name: "GC Corp",
      companyType: "GC",
    });
    await db.doc(`companies/${SUB_COMPANY}`).set({
      id: SUB_COMPANY,
      name: "Sub Corp",
      companyType: "SUB",
    });

    // Company membership docs (flat collection, doc ID = {companyId}_{uid})
    await db.doc(`companyMembers/${GC_COMPANY}_${GC_USER}`).set({
      uid: GC_USER,
      companyId: GC_COMPANY,
      role: "ADMIN",
    });
    await db.doc(`companyMembers/${SUB_COMPANY}_${SUB_USER}`).set({
      uid: SUB_USER,
      companyId: SUB_COMPANY,
      role: "ADMIN",
    });

    // Project connection: links GC_PROJECT to SUB_COMPANY.
    // Doc ID convention enforced by server: {gcProjectId}_{subCompanyId}
    await db
      .doc(`companies/${GC_COMPANY}/projectConnections/${GC_PROJECT}_${SUB_COMPANY}`)
      .set({
        id: `${GC_PROJECT}_${SUB_COMPANY}`,
        gcCompanyId: GC_COMPANY,
        gcProjectId: GC_PROJECT,
        subCompanyId: SUB_COMPANY,
        status: "active",
      });

    // Pending (not active) connection — should not grant access
    await db
      .doc(`companies/${GC_COMPANY}/projectConnections/${UNCONNECTED_PROJECT}_${SUB_COMPANY}`)
      .set({
        id: `${UNCONNECTED_PROJECT}_${SUB_COMPANY}`,
        gcCompanyId: GC_COMPANY,
        gcProjectId: UNCONNECTED_PROJECT,
        subCompanyId: SUB_COMPANY,
        status: "pending",
      });

    // Projects
    await db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}`).set({
      id: GC_PROJECT,
      name: "Main Project",
      companyId: GC_COMPANY,
    });
    await db.doc(`companies/${GC_COMPANY}/projects/${UNCONNECTED_PROJECT}`).set({
      id: UNCONNECTED_PROJECT,
      name: "Other Project",
      companyId: GC_COMPANY,
    });

    // Tasks
    await db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-assigned`).set({
      id: "task-assigned",
      assignedSubCompanyId: SUB_COMPANY,
      companyId: GC_COMPANY,
      projectId: GC_PROJECT,
    });
    await db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-other-sub`).set({
      id: "task-other-sub",
      assignedSubCompanyId: OTHER_SUB_COMPANY,
      companyId: GC_COMPANY,
      projectId: GC_PROJECT,
    });
    await db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-unassigned`).set({
      id: "task-unassigned",
      companyId: GC_COMPANY,
      projectId: GC_PROJECT,
    });

    // Task steps with different canEditBy values
    await db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-sub`).set({
      id: "step-sub",
      canEditBy: "SUB",
      status: "PENDING",
      notes: "",
      companyId: GC_COMPANY,
      projectId: GC_PROJECT,
      dueDate: null,
    });
    await db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-both`).set({
      id: "step-both",
      canEditBy: "BOTH",
      status: "PENDING",
      notes: "",
      companyId: GC_COMPANY,
      projectId: GC_PROJECT,
      dueDate: null,
    });
    await db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-gc`).set({
      id: "step-gc",
      canEditBy: "GC",
      status: "PENDING",
      notes: "",
      companyId: GC_COMPANY,
      projectId: GC_PROJECT,
      dueDate: null,
    });
  });
});

// ── Auth context helpers ──────────────────────────────────────────────────────

function gcUserCtx() {
  return testEnv.authenticatedContext(GC_USER, {
    companyType: "GC",
    companyId: GC_COMPANY,
  });
}

function subUserCtx() {
  return testEnv.authenticatedContext(SUB_USER, {
    companyType: "SUB",
    companyId: SUB_COMPANY,
  });
}

function otherSubUserCtx() {
  return testEnv.authenticatedContext(OTHER_SUB_USER, {
    companyType: "SUB",
    companyId: OTHER_SUB_COMPANY,
  });
}

function unauthCtx() {
  return testEnv.unauthenticatedContext();
}

// ── GC user rules ─────────────────────────────────────────────────────────────

describe("GC user", () => {
  it("can read their own company document", async () => {
    const db = gcUserCtx().firestore();
    await assertSucceeds(db.doc(`companies/${GC_COMPANY}`).get());
  });

  it("can read their own projects", async () => {
    const db = gcUserCtx().firestore();
    await assertSucceeds(db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}`).get());
  });

  it("can read all tasks including unassigned ones", async () => {
    const db = gcUserCtx().firestore();
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-assigned`).get()
    );
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-unassigned`).get()
    );
  });

  it("can read all task steps", async () => {
    const db = gcUserCtx().firestore();
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-sub`).get()
    );
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-gc`).get()
    );
  });

  it("can read project connections", async () => {
    const db = gcUserCtx().firestore();
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projectConnections/${GC_PROJECT}_${SUB_COMPANY}`).get()
    );
  });

  it("cannot read another company's document", async () => {
    const db = gcUserCtx().firestore();
    await assertFails(db.doc(`companies/${SUB_COMPANY}`).get());
  });

  it("cannot write tasks directly (server-side only)", async () => {
    const db = gcUserCtx().firestore();
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/new-task`).set({
        id: "new-task",
        companyId: GC_COMPANY,
      })
    );
  });
});

// ── Sub user — project access ─────────────────────────────────────────────────

describe("Sub user — project access", () => {
  it("can read a GC project with an active connection", async () => {
    const db = subUserCtx().firestore();
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}`).get()
    );
  });

  it("cannot read a GC project with only a pending connection", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projects/${UNCONNECTED_PROJECT}`).get()
    );
  });

  it("cannot read a GC company document", async () => {
    const db = subUserCtx().firestore();
    await assertFails(db.doc(`companies/${GC_COMPANY}`).get());
  });

  it("can read their own sub company document", async () => {
    const db = subUserCtx().firestore();
    await assertSucceeds(db.doc(`companies/${SUB_COMPANY}`).get());
  });

  it("cannot read project connections", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projectConnections/${GC_PROJECT}_${SUB_COMPANY}`).get()
    );
  });
});

// ── Sub user — task read access ───────────────────────────────────────────────

describe("Sub user — task read access", () => {
  it("can read a task assigned to their company", async () => {
    const db = subUserCtx().firestore();
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-assigned`).get()
    );
  });

  it("cannot read a task assigned to a different sub company", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-other-sub`).get()
    );
  });

  it("cannot read an unassigned task", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-unassigned`).get()
    );
  });

  it("cannot read tasks on a project without active connection", async () => {
    // Seed a task on the unconnected project
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx
        .firestore()
        .doc(`companies/${GC_COMPANY}/projects/${UNCONNECTED_PROJECT}/tasks/task-1`)
        .set({ id: "task-1", assignedSubCompanyId: SUB_COMPANY, companyId: GC_COMPANY });
    });
    const db = subUserCtx().firestore();
    await assertFails(
      db
        .doc(`companies/${GC_COMPANY}/projects/${UNCONNECTED_PROJECT}/tasks/task-1`)
        .get()
    );
  });
});

// ── Sub user — task step read access ─────────────────────────────────────────

describe("Sub user — task step read access", () => {
  it("can read task steps on a connected project", async () => {
    const db = subUserCtx().firestore();
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-sub`).get()
    );
    await assertSucceeds(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-gc`).get()
    );
  });

  it("cannot read task steps on a project without active connection", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx
        .firestore()
        .doc(`companies/${GC_COMPANY}/projects/${UNCONNECTED_PROJECT}/taskSteps/step-1`)
        .set({ id: "step-1", canEditBy: "SUB", status: "PENDING", companyId: GC_COMPANY });
    });
    const db = subUserCtx().firestore();
    await assertFails(
      db
        .doc(`companies/${GC_COMPANY}/projects/${UNCONNECTED_PROJECT}/taskSteps/step-1`)
        .get()
    );
  });
});

// ── Sub user — task step write access ────────────────────────────────────────

describe("Sub user — task step write access", () => {
  it("can update status on a step where canEditBy is SUB", async () => {
    const db = subUserCtx().firestore();
    await assertSucceeds(
      db
        .doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-sub`)
        .update({ status: "IN_PROGRESS", updatedAt: new Date() })
    );
  });

  it("can update notes on a step where canEditBy is SUB", async () => {
    const db = subUserCtx().firestore();
    await assertSucceeds(
      db
        .doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-sub`)
        .update({ notes: "Started work", updatedAt: new Date() })
    );
  });

  it("can update status and notes on a step where canEditBy is BOTH", async () => {
    const db = subUserCtx().firestore();
    await assertSucceeds(
      db
        .doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-both`)
        .update({ status: "COMPLETE", notes: "Done", updatedAt: new Date() })
    );
  });

  it("cannot update a step where canEditBy is GC", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db
        .doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-gc`)
        .update({ status: "IN_PROGRESS", updatedAt: new Date() })
    );
  });

  it("cannot update GC-owned fields (e.g., dueDate) even on a SUB-editable step", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db
        .doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-sub`)
        .update({ dueDate: new Date(), updatedAt: new Date() })
    );
  });

  it("cannot update GC-owned fields alongside allowed fields", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db
        .doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-sub`)
        .update({ status: "IN_PROGRESS", dueDate: new Date(), updatedAt: new Date() })
    );
  });

  it("cannot create a new task step", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db
        .doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/new-step`)
        .set({ canEditBy: "SUB", status: "PENDING" })
    );
  });

  it("cannot delete a task step", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/taskSteps/step-sub`).delete()
    );
  });

  it("cannot update steps on a project without active connection", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx
        .firestore()
        .doc(`companies/${GC_COMPANY}/projects/${UNCONNECTED_PROJECT}/taskSteps/step-1`)
        .set({ id: "step-1", canEditBy: "SUB", status: "PENDING", companyId: GC_COMPANY });
    });
    const db = subUserCtx().firestore();
    await assertFails(
      db
        .doc(`companies/${GC_COMPANY}/projects/${UNCONNECTED_PROJECT}/taskSteps/step-1`)
        .update({ status: "IN_PROGRESS", updatedAt: new Date() })
    );
  });
});

// ── Sub user — isolation from other companies ─────────────────────────────────

describe("Sub user — data isolation", () => {
  it("cannot access GC data they have no connection to (different sub company)", async () => {
    // Other sub company has no connection to GC_PROJECT
    const db = otherSubUserCtx().firestore();
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}`).get()
    );
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-assigned`).get()
    );
  });

  it("cannot write tasks regardless of connection", async () => {
    const db = subUserCtx().firestore();
    await assertFails(
      db
        .doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/new-task`)
        .set({ id: "new-task", companyId: GC_COMPANY })
    );
  });
});

// ── Unauthenticated access ────────────────────────────────────────────────────

describe("Unauthenticated user", () => {
  it("cannot read company documents", async () => {
    const db = unauthCtx().firestore();
    await assertFails(db.doc(`companies/${GC_COMPANY}`).get());
  });

  it("cannot read projects", async () => {
    const db = unauthCtx().firestore();
    await assertFails(db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}`).get());
  });

  it("cannot read tasks", async () => {
    const db = unauthCtx().firestore();
    await assertFails(
      db.doc(`companies/${GC_COMPANY}/projects/${GC_PROJECT}/tasks/task-assigned`).get()
    );
  });

  it("cannot read or write anything", async () => {
    const db = unauthCtx().firestore();
    await assertFails(db.collection("companies").get());
    await assertFails(db.collection("companyMembers").get());
  });
});
