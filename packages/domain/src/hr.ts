// HR rules: contracts, French public holidays, working days, and statutory paid leave accrual (L3141-3).
import { t, type Locale } from "@aphrody/auto-platform/i18n";

export const CONTRACTS = [
  "permanent",
  "fixed_term",
  "apprenticeship",
  "professionalization",
  "internship",
  "temporary",
] as const;
export type ContractType = (typeof CONTRACTS)[number];

export const ABSENCE_TYPES = ["paid_leave", "rtt", "sick_leave", "unpaid_leave", "family_event", "other"] as const;
export type AbsenceType = (typeof ABSENCE_TYPES)[number];

export type AbsenceStatus = "requested" | "approved" | "rejected" | "cancelled";

export interface Employee {
  lastName: string;
  firstName: string;
  email?: string;
  role: string;
  contract: ContractType;
  /** YYYY-MM-DD */
  startDate: string;
  endDate?: string;
  /** Working time percentage relative to full-time (100 = full-time). */
  workingTimePercent: number;
  grossMonthlySalaryCents: number;
}

/** Statutory accrual: 2.5 working days per full month worked, capped at 30 days per reference period. */
export const PAID_LEAVE_PER_MONTH = 2.5;
export const PAID_LEAVE_MAX_PERIOD = 30;

const parseDay = (d: string) => new Date(`${d}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Easter Sunday date (Meeus/Jones/Butcher Gregorian algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Eleven statutory French public holidays (Labour Code L3133-1). */
export function publicHolidays(year: number): string[] {
  const easter = parseDay(easterSunday(year));
  return [
    `${year}-01-01`,
    toIso(addDays(easter, 1)),
    `${year}-05-01`,
    `${year}-05-08`,
    toIso(addDays(easter, 39)),
    toIso(addDays(easter, 50)),
    `${year}-07-14`,
    `${year}-08-15`,
    `${year}-11-01`,
    `${year}-11-11`,
    `${year}-12-25`,
  ].sort();
}

/** Working days (Monday to Saturday excluding public holidays) between two inclusive dates. */
export function workingDays(start: string, end: string): number {
  if (end < start) return 0;
  const holidays = new Set<string>();
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    for (const h of publicHolidays(year)) holidays.add(h);
  }
  let count = 0;
  for (let d = parseDay(start); toIso(d) <= end; d = addDays(d, 1)) {
    if (d.getUTCDay() !== 0 && !holidays.has(toIso(d))) count++;
  }
  return count;
}

/** Start of the June 1 statutory leave reference period containing `date`. */
export function referencePeriodStart(date: string): string {
  const year = Number(date.slice(0, 4));
  return date.slice(5) >= "06-01" ? `${year}-06-01` : `${year - 1}-06-01`;
}

/** Accrued paid leave working days (rounded up under L3141-7) up to `asOf` across complete months of employment. */
export function accruedLeaveDays(employee: Pick<Employee, "startDate" | "endDate">, asOf: string): number {
  const start = [referencePeriodStart(asOf), employee.startDate].sort().at(-1)!;
  const end = [asOf, employee.endDate ?? asOf].sort()[0]!;
  if (end < start) return 0;
  let months = 0;
  for (let d = parseDay(start); ; months++) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
    if (toIso(addDays(next, -1)) > end) break;
    d = next;
  }
  return Math.min(PAID_LEAVE_MAX_PERIOD, Math.ceil(months * PAID_LEAVE_PER_MONTH));
}

/** Validate an employee payload (empty array = valid). */
export function verifyEmployee(employee: Partial<Employee>, locale: Locale = "en"): string[] {
  const errors: string[] = [];
  if (!employee.lastName?.trim()) errors.push(t(locale, "Last name is required"));
  if (!employee.firstName?.trim()) errors.push(t(locale, "First name is required"));
  if (!employee.role?.trim()) errors.push(t(locale, "Role is required"));
  if (!CONTRACTS.includes(employee.contract as ContractType)) {
    errors.push(t(locale, "Expected contract type: {list}", { list: CONTRACTS.join(", ") }));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(employee.startDate ?? "")) {
    errors.push(t(locale, "Start date must use YYYY-MM-DD format"));
  }
  if (employee.endDate && employee.endDate < (employee.startDate ?? "")) {
    errors.push(t(locale, "End date cannot precede start date"));
  }
  if (employee.contract === "fixed_term" && !employee.endDate) {
    errors.push(t(locale, "Fixed-term contract requires an end date"));
  }
  if (
    !Number.isInteger(employee.workingTimePercent) ||
    employee.workingTimePercent! <= 0 ||
    employee.workingTimePercent! > 100
  ) {
    errors.push(t(locale, "Working time percentage must be between 1 and 100"));
  }
  if (!Number.isInteger(employee.grossMonthlySalaryCents) || employee.grossMonthlySalaryCents! < 0) {
    errors.push(t(locale, "Gross monthly salary must be an integer number of cents"));
  }
  if (employee.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(employee.email)) {
    errors.push(t(locale, "Invalid email address"));
  }
  return errors;
}
