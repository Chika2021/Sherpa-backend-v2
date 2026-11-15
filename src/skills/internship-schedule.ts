/**
 * Internship duration + daily check-in schedule (pure functions, no I/O).
 *
 * A learner picks how the internship runs:
 *   - "self_paced"  the original behaviour: no calendar, work through the steps whenever you like;
 *   - "timeframe"   a fixed number of MONTHS. The whole internship (every step of every level and
 *                   project, in order) is split into "internship days". The learner checks in to open
 *                   the next day's task, normally once a day, and may open several days at once.
 *
 * Day layout. With T steps in total and D = min(T, months * 30) internship days, internship day k
 * holds the steps whose global index g (0-based) satisfies floor((k-1)*T/D) <= g < floor(k*T/D).
 * When T >= D every day gets one or more steps; when T < D every step is its own day.
 */

export type InternshipDurationMode = 'self_paced' | 'timeframe';

export const DAYS_PER_MONTH = 30;
export const MIN_INTERNSHIP_MONTHS = 1;
export const MAX_INTERNSHIP_MONTHS = 60;

export interface InternshipCheckIn {
  /** When the check-in happened (ISO string - this lives in a JSON column). */
  at: string;
  /** Calendar day of the check-in in the learner's time zone, "YYYY-MM-DD". */
  date: string;
  /** How many internship days this check-in opened (more than 1 = working ahead). */
  daysOpened: number;
  /** Total internship days open after this check-in. */
  daysUnlockedAfter: number;
}

export interface InternshipSchedule {
  mode: InternshipDurationMode;
  /** Chosen length in months (timeframe only). */
  months: number | null;
  /** IANA time zone that decides where one calendar day ends and the next begins. */
  timezone: string;
  /** When the learner chose this schedule (the internship's clock starts here). ISO string. */
  startedAt: string;
  /** Number of internship days opened so far (timeframe only). */
  daysUnlocked: number;
  /** Every check-in, oldest first (capped, see MAX_STORED_CHECK_INS). */
  checkIns: InternshipCheckIn[];
}

export const MAX_STORED_CHECK_INS = 400;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" of `date` in the given time zone. */
export function dateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Whole calendar days from key `a` to key `b` ("YYYY-MM-DD"). Negative when b is earlier. */
export function daysBetweenKeys(a: string, b: string): number {
  const toUtc = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** The calendar day `months` months after `start`, as "YYYY-MM-DD" (end of month is clamped, e.g. 31 Jan + 1 month = 28/29 Feb). */
export function addMonthsKey(startKey: string, months: number): string {
  const [y, m, d] = startKey.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** How many internship days a plan of `totalSteps` steps is split into for a `months`-month internship. */
export function planDays(totalSteps: number, months: number): number {
  if (totalSteps <= 0) return 0;
  return Math.max(1, Math.min(totalSteps, months * DAYS_PER_MONTH));
}

/** The internship day (1-based) a step belongs to. */
export function dayOfStep(globalIndex: number, totalSteps: number, totalDays: number): number {
  return Math.ceil(((globalIndex + 1) * totalDays) / totalSteps);
}

/** How many steps (from the start of the internship) are open once `daysUnlocked` days have been opened. */
export function stepsUnlockedBy(daysUnlocked: number, totalSteps: number, totalDays: number): number {
  if (totalDays <= 0) return 0;
  return Math.min(totalSteps, Math.floor((daysUnlocked * totalSteps) / totalDays));
}

/** Human label for a number of months: "1 month", "3 months". */
export function monthsLabel(months: number): string {
  return `${months} ${months === 1 ? 'month' : 'months'}`;
}

/**
 * The duration to print on the certificate.
 *  - timeframe: the months the learner committed to;
 *  - self-paced: the real time between the first and last activity, rounded to whole months,
 *    or "under 1 month" when it was shorter than that.
 */
export function durationForCertificate(
  schedule: InternshipSchedule | null | undefined,
  startedAt: Date | null,
  completedAt: Date | null,
): { months: number | null; label: string } {
  if (schedule?.mode === 'timeframe' && schedule.months) {
    return { months: schedule.months, label: monthsLabel(schedule.months) };
  }
  if (!startedAt || !completedAt) return { months: null, label: '-' };
  const months = Math.round((completedAt.getTime() - startedAt.getTime()) / (DAYS_PER_MONTH * 86_400_000));
  return months >= 1 ? { months, label: monthsLabel(months) } : { months: null, label: 'under 1 month' };
}
