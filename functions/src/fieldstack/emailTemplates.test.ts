import { describe, it, expect } from "vitest";
import {
  buildScheduleChangeEmailHtml,
  buildEscalationEmailHtml,
  type ScheduleChangeItem,
} from "./emailTemplates";

describe("buildScheduleChangeEmailHtml", () => {
  it("includes task name, project name, and shift days in output", () => {
    const changes: ScheduleChangeItem[] = [
      {
        taskName: "Cabinet Install",
        building: "Building A",
        floor: "Floor 2",
        previousDate: new Date("2026-05-01"),
        newDate: new Date("2026-05-08"),
        shiftDays: 7,
      },
    ];
    const html = buildScheduleChangeEmailHtml(changes, "River Oaks Kitchen");
    expect(html).toContain("Cabinet Install");
    expect(html).toContain("River Oaks Kitchen");
    // shiftDays is rendered as "+7d" — "day" substring is in "days" via the summary line
    expect(html).toMatch(/7/);
  });

  it("includes project name even when the changes array is empty", () => {
    const html = buildScheduleChangeEmailHtml([], "MyProject");
    expect(html).toContain("MyProject");
  });

  it("shows negative shift with correct sign", () => {
    const changes: ScheduleChangeItem[] = [
      {
        taskName: "Countertop Measure",
        previousDate: new Date("2026-06-10"),
        newDate: new Date("2026-06-07"),
        shiftDays: -3,
      },
    ];
    const html = buildScheduleChangeEmailHtml(changes, "Lakeview Reno");
    // Negative shift should NOT have a '+' prefix
    expect(html).toContain("-3d");
    expect(html).not.toContain("+-3d");
  });

  it("returns a non-empty string", () => {
    const html = buildScheduleChangeEmailHtml([], "AnyProject");
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });
});

describe("buildEscalationEmailHtml", () => {
  const baseParams = {
    level: "OVERDUE",
    stepLabel: "Order Materials",
    location: "Building B / Floor 3",
    projectName: "Downtown Lofts",
    assigneeName: "Jane Smith",
    daysOverdue: 2,
    dueInDays: -2,
    projectId: "proj-abc123",
    magicUrl: "https://app.fieldstack.app/tasks/action?token=test.token",
  };

  it("returns a non-empty subject and html", () => {
    const result = buildEscalationEmailHtml(baseParams);
    expect(result.subject).toBeTruthy();
    expect(result.html).toBeTruthy();
  });

  it("includes the step label in subject and html", () => {
    const result = buildEscalationEmailHtml(baseParams);
    expect(result.subject).toContain("Order Materials");
    expect(result.html).toContain("Order Materials");
  });

  it("includes the project name in subject and html", () => {
    const result = buildEscalationEmailHtml(baseParams);
    expect(result.subject).toContain("Downtown Lofts");
    expect(result.html).toContain("Downtown Lofts");
  });

  it("CRITICAL level produces a [CRITICAL] subject prefix", () => {
    const result = buildEscalationEmailHtml({ ...baseParams, level: "CRITICAL" });
    expect(result.subject).toContain("[CRITICAL]");
  });

  it("REMINDER level produces a [REMINDER] subject prefix with dueInDays", () => {
    const result = buildEscalationEmailHtml({
      ...baseParams,
      level: "REMINDER",
      daysOverdue: 0,
      dueInDays: 3,
    });
    expect(result.subject).toContain("[REMINDER]");
    expect(result.subject).toContain("3 day");
  });

  it("includes the magic URL in the html", () => {
    const result = buildEscalationEmailHtml(baseParams);
    expect(result.html).toContain(baseParams.magicUrl);
  });
});
