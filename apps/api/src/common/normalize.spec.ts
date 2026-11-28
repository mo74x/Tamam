import {
  normalizeName,
  normalizeRef,
  parseAmountToPiasters,
  toAsciiDigits,
  transliterateArabicLatinSkeleton,
} from './normalize.js';

describe('Normalization & Transliteration Utilities', () => {
  it('converts Eastern Arabic and Persian digits while preserving separators', () => {
    expect(toAsciiDigits('١٬٢٥٠٫٥٠ / ۱۲۳')).toBe('1٬250٫50 / 123');
    expect(toAsciiDigits('abc')).toBe('abc');
  });

  it('normalizes Arabic & Latin sender names and returns null when empty', () => {
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName('   !!!   ')).toBeNull();
    expect(normalizeName('أَحْمَدُ مُصْطَفَى عُثْمَان')).toBe('احمد مصطفي عثمان');
    expect(normalizeName('  Sara_Store@instapay  ')).toBe('sara store@instapay');
  });

  it('normalizes transaction references and filters values shorter than 4 chars', () => {
    expect(normalizeRef(undefined)).toBeNull();
    expect(normalizeRef('12-3')).toBeNull();
    expect(normalizeRef(' ipn #١٢٣٤-ab ')).toBe('IPN1234AB');
  });

  it('parses EGP amounts into integer piasters safely without float drift', () => {
    expect(parseAmountToPiasters('1,250.50')).toBe(125050n);
    expect(parseAmountToPiasters('١٬٢٥٠٫٥')).toBe(125050n);
    expect(parseAmountToPiasters('650 ج.م')).toBe(65000n);
    expect(parseAmountToPiasters('L.E. 650.25')).toBe(65025n);
    expect(parseAmountToPiasters('EGP ---')).toBeNull();
    expect(parseAmountToPiasters('12.34.56')).toBeNull();
  });

  it('produces matching Arabic-to-Latin consonant skeletons across Egyptian name variants', () => {
    expect(transliterateArabicLatinSkeleton('')).toBe('');
    expect(transliterateArabicLatinSkeleton('!!!')).toBe('');

    expect(transliterateArabicLatinSkeleton('أحمد')).toBe(
      transliterateArabicLatinSkeleton('Ahmed'),
    );
    expect(transliterateArabicLatinSkeleton('محمد')).toBe(
      transliterateArabicLatinSkeleton('Mohamed'),
    );
    expect(transliterateArabicLatinSkeleton('شريف')).toBe(
      transliterateArabicLatinSkeleton('Sherif'),
    );
    expect(transliterateArabicLatinSkeleton('خالد')).toBe(
      transliterateArabicLatinSkeleton('Khaled'),
    );
    expect(transliterateArabicLatinSkeleton('يوسف')).toBe(
      transliterateArabicLatinSkeleton('Youssef'),
    );
    expect(transliterateArabicLatinSkeleton('مصطفى')).toBe(
      transliterateArabicLatinSkeleton('Mostafa'),
    );
    expect(transliterateArabicLatinSkeleton('01012345678')).toBe('01012345678');
  });
});
