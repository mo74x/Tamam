import { UnrecoverableError } from 'bullmq';
import { ChannelType, ProofStatus } from '../generated/prisma/client.js';
import { WhatsAppApiError } from '../channels/whatsapp/whatsapp-api.client.js';
import { RepliesProcessor } from './replies.processor.js';

describe('RepliesProcessor', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    process.env.TAMAM_ALERT_PHONE_NUMBER_ID = 'alert_pn_1';
    process.env.TAMAM_ALERT_ACCESS_TOKEN = 'alert_tok_1';
  });

  afterAll(() => {
    process.env = envSnapshot;
  });

  const makeDeps = () => {
    const prisma = {
      proof: { findUnique: vi.fn(), update: vi.fn() },
      device: { findFirst: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'log_1' }) },
    };
    const crypto = { decrypt: vi.fn().mockReturnValue('chan_tok') };
    const whatsapp = {
      sendTextMessage: vi.fn().mockResolvedValue('wamid.out'),
      sendUtilityTemplate: vi.fn().mockResolvedValue('wamid.tpl'),
    };
    const redis = {
      exists: vi.fn().mockResolvedValue(0),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const processor = new RepliesProcessor(
      prisma as never,
      crypto as never,
      whatsapp as never,
      redis as never,
    );
    return { processor, prisma, crypto, whatsapp, redis };
  };

  it('skips TEST_ROUNDTRIP and coexistence:echo automatic customer replies', async () => {
    const { processor, prisma, whatsapp, redis } = makeDeps();
    prisma.proof.findUnique.mockResolvedValueOnce({
      id: 'p_test',
      statusReason: 'TEST_ROUNDTRIP',
      status: ProofStatus.CONFIRMED,
      createdAt: new Date(),
      seller: { ownerPhone: '+201099999999', channels: [] },
    });

    await processor.process({
      name: 'customer-confirmed',
      data: { sellerId: 's1', customerPhone: '+201012345678', proofId: 'p_test' },
    } as never);
    expect(whatsapp.sendTextMessage).not.toHaveBeenCalled();

    prisma.proof.findUnique.mockResolvedValueOnce({
      id: 'p_coex',
      statusReason: null,
      status: ProofStatus.CONFIRMED,
      isForwarded: false,
      replyToPhone: null,
      createdAt: new Date(),
      channel: { id: 'c1', type: ChannelType.WHATSAPP_COEXISTENCE, phoneNumberId: 'pn1', encryptedToken: 'enc' },
      seller: { ownerPhone: '+201099999999', replyTemplates: null, channels: [] },
    });
    redis.exists.mockResolvedValueOnce(1);

    await processor.process({
      name: 'customer-confirmed',
      data: { sellerId: 's1', customerPhone: '+201012345678', proofId: 'p_coex' },
    } as never);
    expect(whatsapp.sendTextMessage).not.toHaveBeenCalled();
  });

  it('logs CUSTOMER_WINDOW_EXPIRED past 23.5h on dedicated channels and alerts owner instead', async () => {
    const { processor, prisma, whatsapp } = makeDeps();
    const oldCreated = new Date(Date.now() - 24 * 3600_000);
    prisma.proof.findUnique
      .mockResolvedValueOnce({
        id: 'p_old',
        status: ProofStatus.CONFIRMED,
        statusReason: null,
        isForwarded: false,
        replyToPhone: null,
        createdAt: oldCreated,
        channel: { id: 'c1', type: ChannelType.WHATSAPP_DEDICATED, phoneNumberId: 'pn1', encryptedToken: 'enc' },
        seller: { ownerPhone: '+201099999999', replyTemplates: null, channels: [] },
      })
      .mockResolvedValueOnce({
        id: 'p_old',
        extractedAmountPiasters: 65000n,
        replyToPhone: null,
        customer: { phone: '+201012345678', displayName: 'Sara' },
      });

    await processor.process({
      name: 'customer-confirmed',
      data: { sellerId: 's1', customerPhone: '+201012345678', proofId: 'p_old' },
    } as never);

    expect(whatsapp.sendTextMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'CUSTOMER_WINDOW_EXPIRED' }),
    });
    expect(whatsapp.sendUtilityTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'tamam_owner_review_v1' }),
    );
  });

  it('suppresses UNMATCHED alerts when offline or cooled down, keeps SUSPICIOUS always, and omits CONFIRM on ambiguity', async () => {
    const { processor, prisma, whatsapp, redis } = makeDeps();

    // Offline device suppresses UNMATCHED
    prisma.device.findFirst.mockResolvedValueOnce({ id: 'dev_offline' });
    await processor.process({
      name: 'owner-alert',
      data: {
        sellerId: 's1',
        ownerPhone: '+201099999999',
        proofId: 'p1',
        status: ProofStatus.UNMATCHED,
        reasonCode: 'EVIDENCE_TIMEOUT',
      },
    } as never);
    expect(whatsapp.sendUtilityTemplate).not.toHaveBeenCalled();

    // SUSPICIOUS bypasses offline/cooldown and omits CONFIRM on AMBIGUOUS_MULTIPLE_EVIDENCE
    prisma.proof.findUnique.mockResolvedValueOnce({
      id: 'p2',
      extractedAmountPiasters: 65000n,
      replyToPhone: null,
      customer: { phone: '+201012345678', displayName: null },
    });
    await processor.process({
      name: 'owner-alert',
      data: {
        sellerId: 's1',
        ownerPhone: '+201099999999',
        proofId: 'p2',
        status: ProofStatus.SUSPICIOUS,
        reasonCode: 'AMBIGUOUS_MULTIPLE_EVIDENCE',
      },
    } as never);

    expect(whatsapp.sendUtilityTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        quickReplyButtons: [{ index: 1, payload: 'REJECT:p2' }],
      }),
    );

    // Free-form text when owner window active in Redis
    redis.exists.mockResolvedValueOnce(1);
    await processor.process({
      name: 'owner-device-offline',
      data: { sellerId: 's1', ownerPhone: '+201099999999', deviceLabel: 'Phone 1' },
    } as never);
    expect(whatsapp.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+201099999999' }),
    );
  });

  it('routes owner-action-feedback, forwarder-ambiguous-seller, owner-quota-exceeded, and throws UnrecoverableError on 4xx', async () => {
    const { processor, whatsapp } = makeDeps();

    await processor.process({
      name: 'owner-action-feedback',
      data: { sellerId: 's1', recipientPhone: '+201099999999', proofId: 'p1', message: 'تم' },
    } as never);
    await processor.process({
      name: 'forwarder-ambiguous-seller',
      data: { senderPhone: '+201099999999', sellerCount: 2 },
    } as never);
    await processor.process({
      name: 'owner-quota-exceeded',
      data: { sellerId: 's1', ownerPhone: '+201099999999', monthKey: '2026-11', limit: 300 },
    } as never);
    expect(whatsapp.sendTextMessage).toHaveBeenCalledTimes(3);

    whatsapp.sendTextMessage.mockRejectedValueOnce(new WhatsAppApiError('bad', 400, 100, false));
    await expect(
      processor.process({
        name: 'owner-action-feedback',
        data: { sellerId: 's1', recipientPhone: '+201099999999', proofId: 'p1', message: 'fail' },
      } as never),
    ).rejects.toThrow(UnrecoverableError);
  });
});
