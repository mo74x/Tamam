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
  const tokens = toAsciiDigits(String(raw))
    .replace(/٫/g, '.')        // Arabic decimal separator
    .replace(/٬|,/g, '')       // Thousands separators
    .replace(/[^\d.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => /\d/.test(t));

  if (tokens.length !== 1) return null;
  const match = tokens[0].match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const fracRaw = (match[2] ?? '').slice(0, 2).padEnd(2, '0');
  const frac = BigInt(fracRaw);

  return whole * 100n + frac;
}

const ARABIC_TO_LATIN_SKELETON: Record<string, string> = {
  ا: 'a',
  أ: 'a',
  إ: 'a',
  آ: 'a',
  ء: '',
  ب: 'b',
  ت: 't',
  ط: 't',
  ث: 's',
  س: 's',
  ص: 's',
  ج: 'g',
  ح: 'h',
  ه: 'h',
  خ: 'kh',
  د: 'd',
  ض: 'd',
  ذ: 'z',
  ز: 'z',
  ظ: 'z',
  ر: 'r',
  ش: 'sh',
  ع: 'a',
  غ: 'gh',
  ف: 'f',
  ق: 'k',
  ك: 'k',
  ل: 'l',
  م: 'm',
  ن: 'n',
  و: 'w',
  ؤ: 'w',
  ي: 'y',
  ى: 'y',
  ئ: 'y',
  ة: 'a',
};

/**
 * Deterministic Arabic/Latin phonetic skeleton for cross-script sender name matching
 * (e.g. "أحمد" / "Ahmed" -> "hmd", "محمد" / "Mohamed" -> "mhmd", "شريف" / "Sherif" -> "shrf").
 */
export function transliterateArabicLatinSkeleton(token: string): string {
  const base = toAsciiDigits(token)
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .toLowerCase()
    .trim();

  if (!base) return '';

  let mapped = '';
  for (const ch of base) {
    if (ch in ARABIC_TO_LATIN_SKELETON) {
      mapped += ARABIC_TO_LATIN_SKELETON[ch];
    } else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      mapped += ch;
    }
  }

  if (!mapped) return '';

  const latinized = mapped
    .replace(/ph/g, 'f')
    .replace(/th/g, 's')
    .replace(/qu?/g, 'k')
    .replace(/j/g, 'g')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k');

  const lead = latinized[0];
  const rest = latinized.slice(1).replace(/[aeiouwy]/g, '');
  const combined = ((lead >= 'a' && lead <= 'z' && 'aeiou'.includes(lead)) ? '' : lead) + rest;
  const collapsed = combined.replace(/(.)\1+/g, '$1');

  return collapsed || latinized.replace(/(.)\1+/g, '$1');
}