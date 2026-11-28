import { PlanTier } from '../../generated/prisma/client.js';
import { LlmEvidenceFallbackService } from './llm-fallback.service.js';

describe('LlmEvidenceFallbackService', () => {
  const receivedAt = new Date('2026-11-26T10:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('redacts balance & long account numbers and parses valid credit JSON with optional timestamp', async () => {
    const aiClient = {
      extractJson: vi.fn().mockResolvedValue({
        rawText: JSON.stringify({
          isIncomingCredit: true,
          amountEgp: '750.50',
          reference: 'ref-889911',
          sender: 'أحمد علي',
          timestampLocal: '2026-11-26 11:45:00',
        }),
      }),
    };

    const service = new LlmEvidenceFallbackService(aiClient as never);
    const res = await service.parse(
      'تم تحويل 750.50 لحساب 12345678901234 رصيدك الحالي: 15,000.00 جنيه',
      receivedAt,
    );

    expect(aiClient.extractJson).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: expect.stringContaining('[ACCT]'),
      }),
    );
    expect(aiClient.extractJson).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: expect.stringContaining('[BALANCE]'),
      }),
    );
    expect(res).toMatchObject({
      amountPiasters: 75050n,
      ref: 'REF889911',
      sender: 'احمد علي',
      parserName: 'llm_fallback',
      confidence: 0.65,
    });
    expect(res?.time?.toISOString()).toBe('2026-11-26T09:45:00.000Z');
  });

  it('returns null on invalid JSON, schema misses, debits, or non-positive amounts', async () => {
    const aiClient = {
      extractJson: vi
        .fn()
        .mockResolvedValueOnce({ rawText: '{not-json' })
        .mockResolvedValueOnce({ rawText: JSON.stringify({ isIncomingCredit: false, amountEgp: 100, reference: null, sender: null }) })
        .mockResolvedValueOnce({ rawText: JSON.stringify({ isIncomingCredit: true, amountEgp: 0, reference: null, sender: null }) }),
    };

    const service = new LlmEvidenceFallbackService(aiClient as never);
    expect(await service.parse('txt1', receivedAt)).toBeNull();
    expect(await service.parse('txt2', receivedAt)).toBeNull();
    expect(await service.parse('txt3', receivedAt)).toBeNull();
  });

  it('rethrows transient AI client errors so BullMQ can retry', async () => {
    const aiClient = {
      extractJson: vi.fn().mockRejectedValue(new Error('openai text timeout')),
    };

    const service = new LlmEvidenceFallbackService(aiClient as never);
    await expect(service.parse('credit 500', receivedAt)).rejects.toThrow('openai text timeout');
  });

  it('enforces monthly per-seller Redis cap, sets 35d TTL on first call, and logs exhaustion', async () => {
    const aiClient = {
      extractJson: vi.fn().mockResolvedValue({
        rawText: JSON.stringify({
          isIncomingCredit: true,
          amountEgp: 200,
          reference: null,
          sender: null,
        }),
      }),
    };
    const prisma = {
      seller: { findUnique: vi.fn().mockResolvedValue({ plan: PlanTier.STARTER }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'log_1' }) },
    };
    const redis = {
      incr: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(151),
      expire: vi.fn().mockResolvedValue(1),
    };

    const service = new LlmEvidenceFallbackService(
      aiClient as never,
      prisma as never,
      redis as never,
    );

    const first = await service.parse('credit 200', receivedAt, {
      sellerId: 'seller_1',
      senderApp: 'QNB',
    });
    expect(first?.amountPiasters).toBe(20000n);
    expect(redis.expire).toHaveBeenCalledWith('llm:cap:seller_1:2026-11', 35 * 86_400);

    const exhausted = await service.parse('credit 200', receivedAt, {
      sellerId: 'seller_1',
      senderApp: 'QNB',
    });
    expect(exhausted).toBeNull();
    expect(aiClient.extractJson).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sellerId: 'seller_1',
        action: 'EVIDENCE_LLM_CAP_REACHED',
      }),
    });

    // Covers second+ calls without resetting expire and without prisma lookup
    redis.incr.mockResolvedValueOnce(200);
    const noPrismaService = new LlmEvidenceFallbackService(aiClient as never, undefined, redis as never);
    expect(await noPrismaService.parse('credit 200', receivedAt, { sellerId: 'seller_2' })).toBeNull();
  });
});
