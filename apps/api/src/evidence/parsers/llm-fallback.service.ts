import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { AiClientService } from '../../ai/ai-client.service.js';
import { parseCairoTimestampToUtc } from '../../common/cairo-time.js';
import { normalizeName, normalizeRef, parseAmountToPiasters } from '../../common/normalize.js';
import { PlanTier } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ParsedEvidence } from './parser.interface.js';

const PLAN_MONTHLY_LLM_CAPS: Record<PlanTier, number> = {
  [PlanTier.STARTER]: 150,
  [PlanTier.GROWTH]: 800,
  [PlanTier.PRO]: 3000,
};

const LlmExtractionSchema = z.object({
  isIncomingCredit: z.boolean(),
  amountEgp: z.union([z.number(), z.string()]).nullable(),
  reference: z.string().nullable(),
  sender: z.string().nullable(),
  timestampLocal: z.string().nullable().optional(),
});

export interface LlmFallbackOptions {
  sellerId?: string;
  senderApp?: string | null;
}

@Injectable()
export class LlmEvidenceFallbackService {
  private readonly logger = new Logger(LlmEvidenceFallbackService.name);

  constructor(
    private readonly aiClient: AiClientService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  async parse(
    normalizedText: string,
    _receivedAt: Date,
    options?: LlmFallbackOptions,
  ): Promise<ParsedEvidence | null> {
    if (options?.sellerId && this.redis) {
      const monthKey = DateTime.now().setZone('Africa/Cairo').toFormat('yyyy-MM');
      const capKey = `llm:cap:${options.sellerId}:${monthKey}`;

      const seller = this.prisma
        ? await this.prisma.seller.findUnique({
            where: { id: options.sellerId },
            select: { plan: true },
          })
        : null;
      const limit = PLAN_MONTHLY_LLM_CAPS[seller?.plan ?? PlanTier.STARTER];

      const count = await this.redis.incr(capKey);
      if (count === 1) {
        await this.redis.expire(capKey, 35 * 86_400);
      }

      if (count > limit) {
        this.logger.warn(
          `Monthly LLM fallback cap reached for seller=${options.sellerId} (${count}/${limit})`,
        );
        if (this.prisma) {
          await this.prisma.auditLog.create({
            data: {
              sellerId: options.sellerId,
              entityType: 'SELLER',
              entityId: options.sellerId,
              action: 'EVIDENCE_LLM_CAP_REACHED',
              actorType: 'SYSTEM',
              payload: {
                monthKey,
                limit,
                count,
                senderApp: options.senderApp ?? null,
              },
            },
          });
        }
        return null;
      }
    }

    // Redact current balance & long account numbers before sending to third-party LLM
    const redacted = normalizedText
      .replace(
        /(?:رصيدك\s*الحالي|balance|bal)[:\s]*[\d,.٬٫]+\s*(?:جنيه|ج\.م|EGP|LE)?/gi,
        '[BALANCE]',
      )
      .replace(/\b\d{12,20}\b/g, '[ACCT]');

    // Let transient AI/network/timeout errors propagate so BullMQ can retry
    const aiRes = await this.aiClient.extractJson({
      systemPrompt:
        'Extract incoming Egyptian bank/wallet payment notifications as JSON: ' +
        '{ isIncomingCredit: boolean, amountEgp: number|null, reference: string|null, sender: string|null, timestampLocal: string|null }. ' +
        'Set isIncomingCredit=false for debits, OTPs, ads, or balance alerts.',
      userText: redacted,
    });

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(aiRes.rawText);
    } catch {
      this.logger.warn('LLM evidence fallback returned invalid JSON');
      return null;
    }

    const parsed = LlmExtractionSchema.safeParse(rawJson);
    if (!parsed.success || !parsed.data.isIncomingCredit || parsed.data.amountEgp === null) {
      return null;
    }

    const amountPiasters = parseAmountToPiasters(parsed.data.amountEgp);
    if (!amountPiasters || amountPiasters <= 0n) return null;

    return {
      amountPiasters,
      ref: normalizeRef(parsed.data.reference),
      sender: normalizeName(parsed.data.sender),
      time: parseCairoTimestampToUtc(parsed.data.timestampLocal),
      parserName: 'llm_fallback',
      confidence: 0.65,
    };
  }
}
