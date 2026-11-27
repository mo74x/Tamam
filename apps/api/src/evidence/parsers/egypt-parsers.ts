import {
  normalizeName,
  normalizeRef,
  parseAmountToPiasters,
} from '../../common/normalize.js';
import { EvidenceParser, ParsedEvidence } from './parser.interface.js';

export class VodafoneCashParser implements EvidenceParser {
  readonly name = 'vf_cash_v1';

  supports(senderApp: string | null, text: string): boolean {
    const app = (senderApp ?? '').toLowerCase();
    return (
      app.includes('vf-cash') ||
      app.includes('vodafone') ||
      /(فودافون\s*كاش|vf-?cash|محفظتك)/i.test(text)
    );
  }

  parse(text: string, receivedAt: Date): ParsedEvidence | null {
    // Arabic: "تم استلام مبلغ 750.00 جنيه من رقم 01012345678 المسجل باسم Ahmed ..."
    const arMatch = text.match(
      /تم\s*استلام\s*مبلغ\s*([\d,.٬٫]+)\s*(?:جنيه|ج\.م|EGP)\s*من\s*(?:رقم\s*)?(01\d{9}|[\d•*]+)(?:\s*المسجل\s*باسم\s*([^\n.]+?)(?:\s*على\s*رقم|\s*رصيدك|$))?/i,
    );
    // English: "You have received EGP 750.00 from 01012345678 ..."
    const enMatch = text.match(
      /received\s*(?:EGP|LE)?\s*([\d,.٬٫]+)\s*(?:EGP|LE)?\s*from\s*(01\d{9}|[^\s.,]+)/i,
    );

    const match = arMatch ?? enMatch;
    if (!match) return null;

    const amountPiasters = parseAmountToPiasters(match[1]);
    if (!amountPiasters || amountPiasters <= 0n) return null;

    const refMatch = text.match(/(?:رقم\s*العملية|ref(?:erence)?[:#\s]*)([A-Z0-9]{6,20})/i);
    const senderRaw = arMatch?.[3] ? `${arMatch[3]} ${arMatch[2]}` : match[2];

    return {
      amountPiasters,
      ref: normalizeRef(refMatch?.[1]),
      sender: normalizeName(senderRaw),
      time: receivedAt,
      parserName: this.name,
      confidence: 0.98,
    };
  }
}

export class InstaPayParser implements EvidenceParser {
  readonly name = 'instapay_notif_v1';

  supports(senderApp: string | null, text: string): boolean {
    const app = (senderApp ?? '').toLowerCase();
    return (
      app.includes('instapay') ||
      app.includes('ipn') ||
      /(instapay|@instapay|انستاباي|انستا\s*باي|\bIPN\b)/i.test(text)
    );
  }

  parse(text: string, receivedAt: Date): ParsedEvidence | null {
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
    const fromMatch = text.match(/(?:from|من)\s+([^\n.,]+?)(?:\s*(?:ref|رقم|on|في|$))/i);
    const refMatch = text.match(
      /(?:ref(?:erence)?|RRN|رقم\s*(?:مرجعي|العملية))[:#\s-]*([A-Z0-9]{8,24})/i,
    );

    return {
      amountPiasters,
      ref: normalizeRef(refMatch?.[1]),
      sender: normalizeName(ipaMatch?.[1] ?? fromMatch?.[1]),
      time: receivedAt,
      parserName: this.name,
      confidence: refMatch ? 0.99 : 0.94,
    };
  }
}

export class CibParser implements EvidenceParser {
  readonly name = 'cib_sms_v1';

  supports(senderApp: string | null, text: string): boolean {
    const app = (senderApp ?? '').toLowerCase();
    return app === 'cib' || app.includes('cibeg') || /\bCIB\b/i.test(text);
  }

  parse(text: string, receivedAt: Date): ParsedEvidence | null {
    // Only credit alerts (avoid card spend/debit SMS)
    const match = text.match(
      /(?:credited\s+with|تم\s*(?:إضافة|اضافة)\s*مبلغ)\s*(?:EGP)?\s*([\d,.٬٫]+)\s*(?:EGP|جنيه|ج\.م)?/i,
    );
    if (!match) return null;

    const amountPiasters = parseAmountToPiasters(match[1]);
    if (!amountPiasters || amountPiasters <= 0n) return null;

    const refMatch = text.match(/(?:ref[:#\s]*|FT)([A-Z0-9]{6,20})/i);
    const senderMatch = text.match(/(?:from|من)\s+([A-Za-z\u0621-\u064A0-9@._\s]{3,40})/i);

    return {
      amountPiasters,
      ref: normalizeRef(refMatch?.[1]),
      sender: normalizeName(senderMatch?.[1]),
      time: receivedAt,
      parserName: this.name,
      confidence: 0.95,
    };
  }
}

export class NbeParser implements EvidenceParser {
  readonly name = 'nbe_sms_v1';

  supports(senderApp: string | null, text: string): boolean {
    const app = (senderApp ?? '').toLowerCase();
    return (
      app === 'nbe' ||
      app.includes('alahly') ||
      /(الأهلي\s*المصري|الاهلي\s*المصري|\bNBE\b)/i.test(text)
    );
  }

  parse(text: string, receivedAt: Date): ParsedEvidence | null {
    const match = text.match(
      /(?:تم\s*(?:إضافة|اضافة|إيداع|ايداع)\s*مبلغ|credited\s+with)\s*(?:EGP)?\s*([\d,.٬٫]+)\s*(?:EGP|جنيه|ج\.م)?/i,
    );
    if (!match) return null;

    const amountPiasters = parseAmountToPiasters(match[1]);
    if (!amountPiasters || amountPiasters <= 0n) return null;

    const refMatch = text.match(/(?:رقم\s*مرجعي|ref[:#\s]*)([A-Z0-9]{6,22})/i);
    const senderMatch = text.match(/(?:من|from)\s+([A-Za-z\u0621-\u064A0-9@._\s]{3,40})/i);

    return {
      amountPiasters,
      ref: normalizeRef(refMatch?.[1]),
      sender: normalizeName(senderMatch?.[1]),
      time: receivedAt,
      parserName: this.name,
      confidence: 0.95,
    };
  }
}