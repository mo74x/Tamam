import { EvidenceSource } from '../generated/prisma/client.js';
import { EvidenceService } from './evidence.service.js';

describe('EvidenceService', () => {
  it('drops OTP/scam and outgoing messages before queueing', async () => {
    const queue = { add: vi.fn() };
    const service = new EvidenceService(queue as never);
    const receivedAt = new Date('2026-11-26T10:00:00.000Z');

    expect(
      await service.enqueueEvidence({
        sellerId: 's1',
        source: EvidenceSource.SMS_FORWARD,
        senderApp: 'Bank',
        rawText: 'Your verification code is 123456',
        receivedAt,
      }),
    ).toEqual({ accepted: false, reason: 'OTP_OR_SCAM' });

    expect(
      await service.enqueueEvidence({
        sellerId: 's1',
        source: EvidenceSource.SMS_FORWARD,
        senderApp: 'CIB',
        rawText: 'تم خصم مبلغ 500 جنيه من حسابك',
        receivedAt,
      }),
    ).toEqual({ accepted: false, reason: 'OUTGOING' });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('produces identical dedupeHash across whitespace/Arabic-digit normalization and prefers idempotencyKey', async () => {
    const queue = { add: vi.fn().mockResolvedValue({ id: 'job_1' }) };
    const service = new EvidenceService(queue as never);
    const receivedAt = new Date('2026-11-26T10:00:00.000Z');

    const a = await service.enqueueEvidence({
      sellerId: 's1',
      source: EvidenceSource.ANDROID_NOTIF,
      senderApp: 'VF-Cash',
      rawText: 'تم استلام مبلغ ١٠٠ جنيه من 01012345678',
      receivedAt,
      deviceId: 'dev_1',
    });
    const b = await service.enqueueEvidence({
      sellerId: 's1',
      source: EvidenceSource.ANDROID_NOTIF,
      senderApp: 'VF-Cash',
      rawText: '  تم استلام   مبلغ 100 جنيه من 01012345678  ',
      receivedAt: new Date('2026-11-26T10:01:00.000Z'),
      deviceId: 'dev_1',
    });

    expect(a.accepted).toBe(true);
    expect(a.dedupeHash).toBe(b.dedupeHash);

    const keyed = await service.enqueueEvidence({
      sellerId: 's1',
      source: EvidenceSource.ANDROID_NOTIF,
      senderApp: 'VF-Cash',
      rawText: 'تم استلام مبلغ 100 جنيه من 01012345678',
      receivedAt,
      idempotencyKey: 'evt-abc-1',
    });
    expect(keyed.dedupeHash).not.toBe(a.dedupeHash);
    expect(queue.add).toHaveBeenLastCalledWith(
      'parse-and-store',
      expect.objectContaining({ deviceId: null, dedupeHash: keyed.dedupeHash }),
      expect.objectContaining({ jobId: keyed.dedupeHash, attempts: 3 }),
    );
  });
});
