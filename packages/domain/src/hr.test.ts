import { expect, test } from "bun:test";
import {
  accruedLeaveDays,
  easterSunday,
  publicHolidays,
  referencePeriodStart,
  verifyEmployee,
  workingDays,
} from "./hr";

test("computes Easter Sunday and statutory public holidays", () => {
  expect(easterSunday(2024)).toBe("2024-03-31");
  expect(easterSunday(2026)).toBe("2026-04-05");
  expect(easterSunday(2027)).toBe("2027-03-28");
  expect(publicHolidays(2026)).toEqual([
    "2026-01-01",
    "2026-04-06",
    "2026-05-01",
    "2026-05-08",
    "2026-05-14",
    "2026-05-25",
    "2026-07-14",
    "2026-08-15",
    "2026-11-01",
    "2026-11-11",
    "2026-12-25",
  ]);
});

test("counts working days excluding Sundays and public holidays", () => {
  expect(workingDays("2026-05-04", "2026-05-10")).toBe(5);
  expect(workingDays("2026-08-03", "2026-08-08")).toBe(6);
  expect(workingDays("2026-12-28", "2027-01-02")).toBe(5);
  expect(workingDays("2026-05-10", "2026-05-04")).toBe(0);
});

test("accrues 2.5 paid leave days per full month capped at 30", () => {
  expect(referencePeriodStart("2026-05-31")).toBe("2025-06-01");
  expect(referencePeriodStart("2026-06-01")).toBe("2026-06-01");
  const emp = { startDate: "2020-01-01" };
  expect(accruedLeaveDays(emp, "2026-06-15")).toBe(0);
  expect(accruedLeaveDays(emp, "2026-07-01")).toBe(3);
  expect(accruedLeaveDays(emp, "2026-10-31")).toBe(13);
  expect(accruedLeaveDays(emp, "2027-05-31")).toBe(30);
  expect(accruedLeaveDays({ startDate: "2026-09-15" }, "2026-10-14")).toBe(3);
  expect(accruedLeaveDays({ startDate: "2026-09-15" }, "2026-10-13")).toBe(0);
  expect(accruedLeaveDays({ startDate: "2026-06-01", endDate: "2026-08-31" }, "2026-10-31")).toBe(8);
});

test("validates employee attributes", () => {
  const valid = {
    lastName: "Martin",
    firstName: "Lea",
    role: "Operations Assistant",
    contract: "permanent" as const,
    startDate: "2026-01-05",
    workingTimePercent: 100,
    grossMonthlySalaryCents: 220000,
  };
  expect(verifyEmployee(valid)).toEqual([]);
  expect(verifyEmployee({ ...valid, contract: "fixed_term" })).toContain("Fixed-term contract requires an end date");
  expect(verifyEmployee({ ...valid, workingTimePercent: 0 })).toContain(
    "Working time percentage must be between 1 and 100",
  );
  expect(verifyEmployee({ ...valid, endDate: "2025-01-01" })).toContain("End date cannot precede start date");
});
