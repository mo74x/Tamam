import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { PaymentMethod, ProofStatus } from '../generated/prisma/client.js';
import { ProofIngestProcessor } from './proof-ingest.processor.js';

describe('ProofIngestProcessor', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    process.env.TAMAM_ALERT_ACCESS_TOKEN = 'alert_tok_123';
  });

  afterAll(() => {
    process.env = envSnapshot;
  });

  const makeValidPng = async () =>
    sharp({
      create: { width: 300, height: 500, channels: 3, background: { r: 240, g: 240, b: 240 } },
    })
      .png()
      .toBuffer();

  const makeDeps = () => {
    const prisma = {
      proof: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'proof_1' }),
      },
      channel: { findUniqueOrThrow: vi.fn() },
      customer: { upsert: vi.fn().mockResolvedValue({ id: 'cust_1' }) },
      seller: { findUnique: vi.fn().mockResolvedValue({ ownerPhone: '+201099999999' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'log_1' }) },
    };
    const storage = {
      putReceiptImage: vi.fn().mockResolvedValue('key'),
      getReceiptImage: vi.fn(),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    const vision = { extractReceipt: vi.fn() };
    const matchingQueue = { add: vi.fn().mockResolvedValue({ id: 'm1' }) };
    const repliesQueue = { add: vi.fn().mockResolvedValue({ id: 'r1' }) };
    const crypto = { decrypt: vi.fn().mockReturnValue('chan_tok') };
    const whatsappApi = { downloadMedia: vi.fn() };
    const redis = {
      exists: vi.fn().mockResolvedValue(0),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      set: vi.fn().mockResolvedValue('OK'),
    };

    const processor = new ProofIngestProcessor(
      prisma as never,
      storage as never,
      vision as never,
      matchingQueue as never,
      repliesQueue as never,
      crypto as never,
      whatsappApi as never,
      redis as never,
    );

    return {
      processor,
      prisma,
      storage,
      vision,
      matchingQueue,
      repliesQueue,
      crypto,
      whatsappApi,
      redis,
    };
  };

  it('enforces 20/hr per-customer Vision rate limit unless isForwardedByOwner', async () => {
    const { processor, prisma, redis, whatsappApi } = makeDeps();
    redis.incr.mockResolvedValueOnce(21);

    await processor.process({
      data: {
        sellerId: 's1',
        customerPhone: '+201012345678',
        channelMessageId: 'wamid.rate',
        mediaId: 'm1',
        channelId: 'c1',
        receivedAt: '2026-11-26T10:00:00.000Z',
      },
    } as never);

    expect(whatsappApi.downloadMedia).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 'wamid.rate',
        action: 'VISION_RATE_LIMITED',
      }),
    });
  });

  it('caches dropped non-receipts for 24h in wamid:drop and skips future retries', async () => {
    const { processor, storage, vision, redis } = makeDeps();
    const img = await makeValidPng();

    vision.extractReceipt.mockResolvedValueOnce({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      latencyMs: 120,
      estimatedCostMicroUsd: 500,
      data: {
        isPaymentReceipt: false,
        isReadable: true,
        receiptConfidence: 0.2,
        amountEgp: null,
        reference: null,
        timestampLocal: null,
        senderName: null,
        paymentMethod: PaymentMethod.UNKNOWN,
        visualAnomalies: [],
      },
    });

    await processor.process({
      data: {
        sellerId: 's1',
        customerPhone: '+201012345678',
        channelMessageId: 'wamid.product',
        imageBase64: img.toString('base64'),
        receivedAt: '2026-11-26T10:00:00.000Z',
      },
    } as never);

    expect(redis.set).toHaveBeenCalledWith('wamid:drop:wamid.product', '1', 'EX', 86_400);
    expect(storage.putReceiptImage).not.toHaveBeenCalled();

    redis.exists.mockResolvedValueOnce(1);
    await processor.process({
      data: {
        sellerId: 's1',
        customerPhone: '+201012345678',
        channelMessageId: 'wamid.product',
        receivedAt: '2026-11-26T10:00:00.000Z',
      },
    } as never);
    expect(vision.extractReceipt).toHaveBeenCalledTimes(1);
  });

  it('downloads forwarded media with TAMAM_ALERT_ACCESS_TOKEN, leaves null extractedTime, and rolls back S3 on DB failure', async () => {
    const { processor, prisma, storage, vision, whatsappApi } = makeDeps();
    const img = await makeValidPng();

    prisma.channel.findUniqueOrThrow.mockResolvedValue({
      type: 'WHATSAPP_FORWARD',
      encryptedToken: null,
    });
    whatsappApi.downloadMedia.mockResolvedValue({ buffer: img, mimeType: 'image/png' });
    vision.extractReceipt.mockResolvedValue({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      latencyMs: 100,
      estimatedCostMicroUsd: 500,
      data: {
        isPaymentReceipt: true,
        isReadable: true,
        receiptConfidence: 0.95,
        amountEgp: '650.00',
        reference: 'IPN12345678',
        timestampLocal: null,
        senderName: 'Sara Ali',
        paymentMethod: PaymentMethod.INSTAPAY,
        visualAnomalies: [],
      },
    });

    await processor.process({
      data: {
        sellerId: 's1',
        customerPhone: null,
        isForwardedByOwner: true,
        replyToPhone: '+201099999999',
        channelMessageId: 'wamid.fwd',
        channelId: 'c_fwd',
        mediaId: 'med_1',
        receivedAt: '2026-11-26T10:00:00.000Z',
      },
    } as never);

    expect(whatsappApi.downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'alert_tok_123' }),
    );
    expect(prisma.proof.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        extractedTime: null,
        visionCostMicroUsd: 500,
        isForwarded: true,
        replyToPhone: '+201099999999',
      }),
    });

    prisma.proof.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      processor.process({
        data: {
          sellerId: 's1',
          customerPhone: null,
          isForwardedByOwner: true,
          channelMessageId: 'wamid.fail',
          imageBase64: img.toString('base64'),
          receivedAt: '2026-11-26T10:00:00.000Z',
        },
      } as never),
    ).rejects.toThrow('db down');
    expect(storage.deleteObject).toHaveBeenCalledWith('proofs/s1/wamid.fail.jpg');
  });

  it('persists UNREADABLE_IMAGE on decode error and VISION_UNAVAILABLE on final BullMQ attempt', async () => {
    const { processor, prisma, vision, repliesQueue, storage } = makeDeps();

    await expect(
      processor.process({
        attemptsMade: 0,
        opts: { attempts: 4 },
        data: {
          sellerId: 's1',
          customerPhone: '+201012345678',
          channelMessageId: 'wamid.corrupt',
          imageBase64: Buffer.from('not-an-image').toString('base64'),
          receivedAt: '2026-11-26T10:00:00.000Z',
        },
      } as never),
    ).rejects.toThrow(UnrecoverableError);

    expect(prisma.proof.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          imageKey: null,
          imagePhash: null,
          status: ProofStatus.UNMATCHED,
          statusReason: 'UNREADABLE_IMAGE',
        }),
      }),
    );

    const img = await makeValidPng();
    vision.extractReceipt.mockRejectedValueOnce(new Error('providers unavailable'));
    storage.getReceiptImage.mockResolvedValueOnce(img);

    await processor.process({
      attemptsMade: 3,
      opts: { attempts: 4 },
      data: {
        sellerId: 's1',
        customerPhone: '+201012345678',
        channelMessageId: 'wamid.visfail',
        imageKey: 'proofs/s1/preuploaded.jpg',
        receivedAt: '2026-11-26T10:00:00.000Z',
      },
    } as never);

    expect(prisma.proof.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ProofStatus.UNMATCHED,
          statusReason: 'VISION_UNAVAILABLE',
        }),
      }),
    );
    expect(repliesQueue.add).toHaveBeenCalledWith(
      'owner-alert',
      expect.objectContaining({ status: 'UNMATCHED', reasonCode: 'VISION_UNAVAILABLE' }),
    );
  });
});
