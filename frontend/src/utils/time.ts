/**
 * Timestamp utilities — ensures all UTC datetimes from the backend are
 * correctly converted to the user's local timezone before display.
 *
 * Problem:
 *   The backend stores all datetimes as naive UTC.  FastAPI's encoder appends
 *   "Z" so the wire format is "2026-05-13T10:15:12Z".  However, some API paths
 *   (direct SQLAlchemy → dict serialisation) may omit the "Z", resulting in
 *   the browser treating the timestamp as *local* time and displaying it
 *   8–9 hours off for JST/CST users.
 *
 * Fix:
 *   Always normalise the string to include a "Z" suffix before handing it to
 *   dayjs.  If the string already carries explicit timezone info (Z or ±HH:MM)
 *   we leave it alone.
 */

import dayjs from 'dayjs'

/**
 * Parse a datetime string from the API, guaranteeing UTC interpretation.
 *
 * Handles:
 *   - "2026-05-13T10:15:12Z"      → parse as UTC (already has Z)
 *   - "2026-05-13T10:15:12"       → treat as UTC, append Z
 *   - "2026-05-13 10:15:12"       → MySQL-style, normalise + treat as UTC
 *   - "2026-05-13T10:15:12+09:00" → already tz-aware, use as-is
 */
export function parseUtc(time: string | null | undefined): dayjs.Dayjs {
  if (!time) return dayjs()
  // Normalise space-separated MySQL format to ISO-8601
  let s = time.replace(' ', 'T')
  // Append Z only when no timezone indicator is present
  if (!s.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(s)) {
    s += 'Z'
  }
  return dayjs(s)
}

/**
 * Format a UTC datetime string into the user's local timezone.
 *
 * @param time   Raw timestamp string from the API
 * @param fmt    dayjs format string (default: 'YYYY-MM-DD HH:mm')
 * @param fallback  Returned when `time` is empty (default: '—')
 */
export function fmtUtc(
  time: string | null | undefined,
  fmt = 'YYYY-MM-DD HH:mm',
  fallback = '—',
): string {
  if (!time) return fallback
  return parseUtc(time).format(fmt)
}

/** Convenience: format with seconds. */
export const fmtUtcSec = (time: string | null | undefined) =>
  fmtUtc(time, 'YYYY-MM-DD HH:mm:ss')

/** Convenience: format time only. */
export const fmtUtcTime = (time: string | null | undefined) =>
  fmtUtc(time, 'HH:mm:ss')
