import { EvidenceSource, Prisma } from '../generated/prisma/client.js';
import { EvidenceIngestProcessor } from './evidence.processor.js';

describe('EvidenceIngestProcessor', () => {
  const makeDeps = () => {
    const prisma = {
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'log_1' }) },
      device: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      evidence: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'ev_1' }),
      },
    };
    const parserRegistry = { parse: vi.fn() };
    const matchingQueue = { add: vi.fn().mockResolvedValue({ id: 'm1' }) };
    const processor = new EvidenceIngestProcessor(
      prisma as never,
      parserRegistry as never,
      matchingQueue as never,
    );
    return { prisma, parserRegistry, matchingQueue, processor };
  };

  it('rejects personal MSISDN senderApp pre-DB on non-manual sources', async () => {
    const { prisma, parserRegistry, matchingQueue, processor } = makeDeps();

    await processor.process({
      data: {
        sellerId: 's1',
        source: EvidenceSource.SMS_FORWARD,
        senderApp: '+201012345678',
        rawText: 'Fake credit message 500 EGP',
        receivedAt: '2026-11-26T10:00:00.000Z',
        dedupeHash: 'hash_1',
      },
    } as never);

    expect(parserRegistry.parse).not.toHaveBeenCalled();
    expect(prisma.evidence.create).not.toHaveBeenCalled();
    expect(matchingQueue.add).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'EVIDENCE_PERSONAL_SENDER_IGNORED' }),
    });
  });

  it('persists unparsed texts without enqueueing matching and triggers async device heartbeat', async () => {
    const { prisma, parserRegistry, matchingQueue, processor } = makeDeps();
    parserRegistry.parse.mockResolvedValue(null);

    await processor.process({
      data: {
        sellerId: 's1',
        source: EvidenceSource.ANDROID_NOTIF,
        senderApp: 'UnknownBank',
        rawText: 'Unrecognized credit alert',
        receivedAt: '2026-11-26T10:00:00.000Z',
        dedupeHash: 'hash_2',
        deviceId: 'dev_1',
      },
    } as never);

    expect(prisma.device.updateMany).toHaveBeenCalledWith({
      where: { id: 'dev_1', sellerId: 's1' },
      data: expect.objectContaining({ offlineAlerted: false }),
    });
    expect(prisma.evidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parsedAmountPiasters: null,
        parsedTime: null,
        parserName: 'unparsed',
        parseConfidence: 0,
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'EVIDENCE_PARSE_FAILED' }),
    });
    expect(matchingQueue.add).not.toHaveBeenCalled();
  });

  it('skips cross-source ±180s duplicates when ref is null', async () => {
    const { prisma, parserRegistry, matchingQueue, processor } = makeDeps();
    parserRegistry.parse.mockResolvedValue({
      amountPiasters: 50000n,
      ref: null,
      sender: 'ahmed ali',
      time: null,
      parserName: 'vf_cash_v1',
      confidence: 0.98,
    });
    prisma.evidence.findFirst.mockResolvedValue({
      id: 'ev_existing',
      source: EvidenceSource.SMS_FORWARD,
    });

    await processor.process({
      data: {
        sellerId: 's1',
        source: EvidenceSource.ANDROID_NOTIF,
        senderApp: 'VF-Cash',
        rawText: 'received 500',
        receivedAt: '2026-11-26T10:00:00.000Z',
        dedupeHash: 'hash_3',
      },
    } as never);

    expect(prisma.evidence.create).not.toHaveBeenCalled();
    expect(matchingQueue.add).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 'ev_existing',
        action: 'EVIDENCE_CROSS_SOURCE_DEDUPE',
      }),
    });
  });

  it('logs EVIDENCE_SEMANTIC_DEDUPE on P2002 semanticKey collision and enqueues matching on new parsed rows', async () => {
    const { prisma, parserRegistry, matchingQueue, processor } = makeDeps();
    parserRegistry.parse.mockResolvedValue({
      amountPiasters: 65000n,
      ref: 'IPN123456',
      sender: 'sara@instapay',
      time: null,
      parserName: 'instapay_notif_v1',
      confidence: 0.99,
    });

    await processor.process({
      data: {
        sellerId: 's1',
        source: EvidenceSource.MANUAL_PASTE,
        senderApp: null,
        rawText: 'pasted text',
        receivedAt: '2026-11-26T10:00:00.000Z',
        dedupeHash: 'hash_4',
      },
    } as never);

    expect(parserRegistry.parse).toHaveBeenCalledWith(null, 'pasted text', expect.any(Date), {
      allowUnscopedFallback: true,
      sellerId: 's1',
    });
    expect(prisma.evidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ semanticKey: 's1:IPN123456:65000' }),
    });
    expect(matchingQueue.add).toHaveBeenCalledWith(
      'match-evidence',
      { sellerId: 's1', evidenceId: 'ev_1' },
      expect.any(Object),
    );

    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique failed', {
      code: 'P2002',
      clientVersion: '7.10.1',
    });
    prisma.evidence.create.mockRejectedValueOnce(p2002);
    prisma.evidence.findUnique.mockResolvedValueOnce({ id: 'ev_1' });

    await processor.process({
      data: {
        sellerId: 's1',
        source: EvidenceSource.ANDROID_NOTIF,
        senderApp: 'instapay',
        rawText: 'notif text',
        receivedAt: '2026-11-26T10:00:00.000Z',
        dedupeHash: 'hash_5',
      },
    } as never);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 'ev_1',
        action: 'EVIDENCE_SEMANTIC_DEDUPE',
      }),
    });
  });
});
