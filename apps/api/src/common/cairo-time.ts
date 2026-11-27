import { DateTime } from 'luxon';
import { toAsciiDigits } from './normalize.js';

const CANDIDATE_FORMATS = [
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd HH:mm',
  'dd/MM/yyyy HH:mm:ss',
  'dd/MM/yyyy HH:mm',
  'dd/MM/yyyy hh:mm a',
  'dd-MM-yyyy HH:mm',
  'dd MMM yyyy hh:mm a',
];

export function parseCairoTimestampToUtc(raw?: string | null): Date | null {
  if (!raw) return null;
  const cleaned = toAsciiDigits(raw)
    .replace(/ص/g, 'AM')
    .replace(/م/g, 'PM')
    .replace(/\s+/g, ' ')
    .trim();

  let dt = DateTime.fromISO(cleaned, { zone: 'Africa/Cairo' });
  if (!dt.isValid) {
    for (const fmt of CANDIDATE_FORMATS) {
      const attempt = DateTime.fromFormat(cleaned, fmt, { zone: 'Africa/Cairo' });
      if (attempt.isValid) {
        dt = attempt;
        break;
      }
    }
  }

  if (!dt.isValid) return null;

  // Reject OCR hallucinations more than 30 days old or >15 min in the future
  const nowMs = Date.now();
  const parsedMs = dt.toMillis();
  if (parsedMs > nowMs + 15 * 60_000 || parsedMs < nowMs - 30 * 86_400_000) {
    return null;
  }

  return dt.toUTC().toJSDate();
}