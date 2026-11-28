import { parseCairoTimestampToUtc } from './cairo-time.js';

describe('parseCairoTimestampToUtc', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for missing or unparseable timestamps', () => {
    expect(parseCairoTimestampToUtc(null)).toBeNull();
    expect(parseCairoTimestampToUtc('')).toBeNull();
    expect(parseCairoTimestampToUtc('not a timestamp')).toBeNull();
  });

  it('parses ISO and Egyptian receipt formats with Arabic AM/PM markers in Africa/Cairo', () => {
    expect(parseCairoTimestampToUtc('2026-11-26T12:00:00')?.toISOString()).toBe(
      '2026-11-26T10:00:00.000Z',
    );
    expect(parseCairoTimestampToUtc('٢٦/١١/٢٠٢٦ ٠٢:١٥ م')?.toISOString()).toBe(
      '2026-11-26T12:15:00.000Z',
    );
    expect(parseCairoTimestampToUtc('26/11/2026 09:05 ص')?.toISOString()).toBe(
      '2026-11-26T07:05:00.000Z',
    );
  });

  it('rejects hallucinated dates older than 30 days or more than 15 minutes in the future', () => {
    expect(parseCairoTimestampToUtc('2026-10-01 12:00:00')).toBeNull();
    expect(parseCairoTimestampToUtc('2026-11-26 14:30:00')).toBeNull(); // +30m in future vs 14:00 Cairo
  });
});
