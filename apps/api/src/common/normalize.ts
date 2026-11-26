const ARABIC_INDIC_MAP: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

export function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => ARABIC_INDIC_MAP[ch] ?? ch);
}

/**
 * Normalizes Arabic & Latin sender names for fuzzy matching:
 * strips diacritics/tatweel, unifies alef/teh marbuta/alef maksura.
 */
export function normalizeName(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = toAsciiDigits(input)
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // diacritics + tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/[^a-z0-9\u0621-\u064A@.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Normalizes transaction references (strips spaces/dashes, uppercase ASCII).
 */
export function normalizeRef(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = toAsciiDigits(input)
    .replace(/[\s\-_#]/g, '')
    .toUpperCase()
    .trim();

  return cleaned.length >= 4 ? cleaned : null;
}

/**
 * Parses EGP amounts safely into integer piasters (BigInt) without floating-point drift.
 * Handles "1,250.50", "١٢٥٠٫٥", "EGP 650", "650 ج.م".
 */
export function parseAmountToPiasters(raw: string | number): bigint | null {
  const str = toAsciiDigits(String(raw))
    .replace(/٫/g, '.')        // Arabic decimal separator
    .replace(/٬|,/g, '')       // Thousands separators
    .replace(/[^\d.]/g, '');   // Strip currency text (EGP, ج.م, LE)

  if (!str) return null;
  const match = str.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const fracRaw = (match[2] ?? '').slice(0, 2).padEnd(2, '0');
  const frac = BigInt(fracRaw);

  return whole * 100n + frac;
}