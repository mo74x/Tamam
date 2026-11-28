import { parseCairoTimestampToUtc } from '../../common/cairo-time.js';
import {
  normalizeName,
  normalizeRef,
  parseAmountToPiasters,
  toAsciiDigits,
} from '../../common/normalize.js';
import { EvidenceParser, ParsedEvidence } from './parser.interface.js';

const TIMESTAMP_PATTERN =
  /(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?|\d{2}[/-]\d{2}[/-]\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM|ص|م))?|\d{2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i;

const SENDER_CLAUSE_RE =
  /(?:from|من)\s+([^\n,]+?)(?:\s+(?:ref\b|RRN\b|رقم(?=\s|:)|on\b|في(?=\s))|[,\n]|$)/i;

function extractEmbeddedTime(text: string): Date | null {
  const ascii = toAsciiDigits(text);
  const match = ascii.match(TIMESTAMP_PATTERN);
  return match ? parseCairoTimestampToUtc(match[1]) : null;
}

const VF_CASH_ALLOWLIST = new Set([
  'vf-cash',
  'vodafone',
  'com.emeint.android.myservices',
]);

const INSTAPAY_ALLOWLIST = new Set([
  'com.egyptianbanks.instapay',
  'instapay',
  'ipn',
]);

const CIB_ALLOWLIST = new Set(['cib', 'cibeg', 'com.cib.mobile']);

const NBE_ALLOWLIST = new Set(['nbe', 'alahly', 'com.nbe.mobile']);

export class VodafoneCashParser implements EvidenceParser {
  readonly name = 'vf_cash_v1';

  supports(senderApp: string | null): boolean {
    const app = (senderApp ?? '').trim().toLowerCase();
    return app.length > 0 && VF_CASH_ALLOWLIST.has(app);
  }

  parse(text: string, _receivedAt: Date): ParsedEvidence | null {
    // Arabic: "تم استلام مبلغ 750.00 جنيه من رقم 01012345678 المسجل باسم Ahmed ..."
    const arMatch = text.match(
      /تم\s*استلام\s*مبلغ\s*([\d,.٬٫]+)\s*(?:جنيه|ج\.م|EGP)\s*من\s*(?:رقم\s*)?(01\d{9}|[\d•*]+)(?:\s*المسجل\s*باسم\s*([^\n.]+?)(?:\s+على\s*رقم|\s+رصيدك|\s+رقم(?=\s)|\s+ref\b|$))?/i,
    );
    // English: "You have received EGP 750.00 from 01012345678 ..."
    const enMatch = text.match(
      /received\s*(?:EGP|LE)?\s*([\d,.٬٫]+)\s*(?:EGP|LE)?\s*from\s*(01\d{9}|[^\n.,]+?)(?:\s+(?:on|at|ref|reference)\b|[.]|$)/i,
    );

    const match = arMatch ?? enMatch;
    if (!match) return null;

    const amountPiasters = parseAmountToPiasters(match[1]);
    if (!amountPiasters || amountPiasters <= 0n) return null;

    const refMatch = text.match(/(?:رقم\s*العملية|ref(?:erence)?)[:#\s-]*([A-Z0-9]{6,20})/i);
    const senderRaw = arMatch?.[3] ? `${arMatch[3]} ${arMatch[2]}` : match[2];

    return {
      amountPiasters,
      ref: normalizeRef(refMatch?.[1]),
      sender: normalizeName(senderRaw),
      time: extractEmbeddedTime(text),
      parserName: this.name,
      confidence: 0.98,
    };
  }
}

export class InstaPayParser implements EvidenceParser {
  readonly name = 'instapay_notif_v1';

  supports(senderApp: string | null): boolean {
    const app = (senderApp ?? '').trim().toLowerCase();
    return app.length > 0 && INSTAPAY_ALLOWLIST.has(app);
  }

  parse(text: string, _receivedAt: Date): ParsedEvidence | null {
    // Guard: must indicate incoming credit
    if (!/(received|credited|تم\s*استلام|تم\s*إضافة|تم\s*اضافة|وصلتك)/i.test(text)) {
      return null;
    }

    const amountMatch = text.match(
      /(?:EGP|LE|مبلغ|بمبلغ)\s*([\d,.٬٫]+)|([\d,.٬٫]+)\s*(?:EGP|LE|جنيه|ج\.م)/i,
    );
    const amountRaw = amountMatch?.[1] ?? amountMatch?.[2];
    const amountPiasters = amountRaw ? parseAmountToPiasters(amountRaw) : null;
    if (!amountPiasters || amountPiasters <= 0n) return null;

    const ipaMatch = text.match(/([a-zA-Z0-9._-]+@instapay)/i);
    const fromMatch = text.match(SENDER_CLAUSE_RE);
    const senderClause = fromMatch?.[1] ?? '';
    const phoneInFrom = senderClause.match(/\b(01\d{9})\b/)?.[1] ?? null;

    const refMatch = text.match(
      /(?:ref(?:erence)?|RRN|رقم\s*(?:مرجعي|العملية))[:#\s-]*([A-Z0-9]{8,24})/i,
    );

    const baseSender = ipaMatch?.[1] ?? fromMatch?.[1] ?? null;
    const senderCombined =
      baseSender && phoneInFrom && !baseSender.includes(phoneInFrom)
        ? `${baseSender} ${phoneInFrom}`
        : baseSender;

    return {
      amountPiasters,
      ref: normalizeRef(refMatch?.[1]),
      sender: normalizeName(senderCombined),
      time: extractEmbeddedTime(text),
      parserName: this.name,
      confidence: refMatch ? 0.99 : 0.94,
    };
  }
}

export class CibParser implements EvidenceParser {
  readonly name = 'cib_sms_v1';

  supports(senderApp: string | null): boolean {
    const app = (senderApp ?? '').trim().toLowerCase();
    return app.length > 0 && CIB_ALLOWLIST.has(app);
  }

  parse(text: string, _receivedAt: Date): ParsedEvidence | null {
    // Only credit alerts (avoid card spend/debit SMS)
    const match = text.match(
      /(?:credited\s+with|تم\s*(?:إضاف[ةه]|اضاف[ةه])\s*مبلغ)\s*(?:EGP)?\s*([\d,.٬٫]+)\s*(?:EGP|جنيه|ج\.م)?/i,
    );
    if (!match) return null;

    const amountPiasters = parseAmountToPiasters(match[1]);
    if (!amountPiasters || amountPiasters <= 0n) return null;

    const refMatch = text.match(/(?:ref(?:erence)?[:#\s-]*|FT)([A-Z0-9]{6,20})/i);
    const senderMatch = text.match(SENDER_CLAUSE_RE);

    return {
      amountPiasters,
      ref: normalizeRef(refMatch?.[1]),
      sender: normalizeName(senderMatch?.[1]),
      time: extractEmbeddedTime(text),
      parserName: this.name,
      confidence: 0.95,
    };
  }
}

export class NbeParser implements EvidenceParser {
  readonly name = 'nbe_sms_v1';

  supports(senderApp: string | null): boolean {
    const app = (senderApp ?? '').trim().toLowerCase();
    return app.length > 0 && NBE_ALLOWLIST.has(app);
  }

  parse(text: string, _receivedAt: Date): ParsedEvidence | null {
    const match = text.match(
      /(?:تم\s*(?:إضاف[ةه]|اضاف[ةه]|إيداع|ايداع)\s*مبلغ|credited\s+with)\s*(?:EGP)?\s*([\d,.٬٫]+)\s*(?:EGP|جنيه|ج\.م)?/i,
    );
    if (!match) return null;

    const amountPiasters = parseAmountToPiasters(match[1]);
    if (!amountPiasters || amountPiasters <= 0n) return null;

    const refMatch = text.match(/(?:رقم\s*(?:مرجعي|العملية)|ref(?:erence)?)[:#\s-]*([A-Z0-9]{6,22})/i);
    const senderMatch = text.match(SENDER_CLAUSE_RE);

    return {
      amountPiasters,
      ref: normalizeRef(refMatch?.[1]),
      sender: normalizeName(senderMatch?.[1]),
      time: extractEmbeddedTime(text),
      parserName: this.name,
      confidence: 0.95,
    };
  }
}
