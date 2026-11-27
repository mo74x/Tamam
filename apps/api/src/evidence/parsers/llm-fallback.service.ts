import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { normalizeName, normalizeRef, parseAmountToPiasters } from '../../common/normalize.js';
import { ParsedEvidence } from './parser.interface.js';

const LlmExtractionSchema = z.object({
  isIncomingCredit: z.boolean(),
  amountEgp: z.union([z.number(), z.string()]).nullable(),
  reference: z.string().nullable(),
  sender: z.string().nullable(),
});

export interface LlmTextClient {
  extractJson(systemPrompt: string, userText: string): Promise<unknown>;
}

@Injectable()
export class LlmEvidenceFallbackService {
  private readonly logger = new Logger(LlmEvidenceFallbackService.name);

  constructor(private readonly llm: LlmTextClient) {}

  async parse(normalizedText: string, receivedAt: Date): Promise<ParsedEvidence | null> {
    // Redact current balance & long account numbers before sending to third-party LLM
    const redacted = normalizedText
      .replace(/(?:رصيدك\s*الحالي|balance|bal)[:\s]*[\d,.]+\s*(?:جنيه|EGP|LE)?/gi, '[BALANCE]')
      .replace(/\b\d{12,20}\b/g, '[ACCT]');

    try {
      const raw = await this.llm.extractJson(
        'Extract incoming Egyptian bank/wallet payment notifications as JSON: ' +
          '{ isIncomingCredit: boolean, amountEgp: number|null, reference: string|null, sender: string|null }. ' +
          'Set isIncomingCredit=false for debits, OTPs, ads, or balance alerts.',
        redacted,
      );

      const parsed = LlmExtractionSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.isIncomingCredit || parsed.data.amountEgp === null) {
        return null;
      }

      const amountPiasters = parseAmountToPiasters(parsed.data.amountEgp);
      if (!amountPiasters || amountPiasters <= 0n) return null;

      return {
        amountPiasters,
        ref: normalizeRef(parsed.data.reference),
        sender: normalizeName(parsed.data.sender),
        time: receivedAt,
        parserName: 'llm_fallback',
        confidence: 0.65, // Explicitly low-confidence until a dedicated regex parser is added
      };
    } catch (err) {
      this.logger.warn(`LLM evidence fallback failed: ${(err as Error).message}`);
      return null;
    }
  }
}