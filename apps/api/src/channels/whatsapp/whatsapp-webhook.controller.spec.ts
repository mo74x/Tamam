import { ChannelType } from '../../generated/prisma/client.js';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller.js';

describe('WhatsAppWebhookController', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify_tok_123';
    process.env.TAMAM_ALERT_PHONE_NUMBER_ID = 'alert_pn_1';
  });

  afterAll(() => {
    process.env = envSnapshot;
  });

  const makeController = () => {
    const prisma = {
      channel: { findUnique: vi.fn() },
      seller: { findMany: vi.fn() },
    };
    const proofQueue = { add: vi.fn().mockResolvedValue({ id: 'p_job' }) };
    const matchingQueue = { add: vi.fn().mockResolvedValue({ id: 'm_job' }) };
    const repliesQueue = { add: vi.fn().mockResolvedValue({ id: 'r_job' }) };
    const redis = { set: vi.fn().mockResolvedValue('OK') };

    const controller = new WhatsAppWebhookController(
      prisma as never,
      proofQueue as never,
      matchingQueue as never,
      repliesQueue as never,
      redis as never,
    );

    return { controller, prisma, proofQueue, matchingQueue, repliesQueue, redis };
  };

  it('records 15m coexistence:echo Redis key when receiving smb_message_echoes', async () => {
    const { controller, prisma, redis, proofQueue } = makeController();
    prisma.channel.findUnique.mockResolvedValue({
      sellerId: 'seller_1',
      isActive: true,
      type: ChannelType.WHATSAPP_COEXISTENCE,
    });

    await controller.handleEvent({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'smb_message_echoes',
              value: {
                metadata: { phone_number_id: 'coex_pn_1' },
                message_echoes: [{ id: 'wamid.e1', from: '201099999999', to: '201012345678', timestamp: '1764151200', type: 'text' }],
              },
            },
          ],
        },
      ],
    });

    expect(redis.set).toHaveBeenCalledWith(
      'coexistence:echo:seller_1:+201012345678',
      '1',
      'EX',
      900,
    );
    expect(proofQueue.add).not.toHaveBeenCalled();
  });

  it('queues owner button actions onto matching and keeps webhook non-blocking', async () => {
    const { controller, matchingQueue, redis } = makeController();

    await controller.handleEvent({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'alert_pn_1' },
                messages: [
                  {
                    id: 'wamid.btn1',
                    from: '201099999999',
                    timestamp: '1764151200',
                    type: 'interactive',
                    interactive: { button_reply: { id: 'CONFIRM:proof123' } },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(redis.set).toHaveBeenCalledWith('alert:owner-window:+201099999999', '1', 'EX', 84_600);
    expect(matchingQueue.add).toHaveBeenCalledWith(
      'owner-action',
      { proofId: 'proof123', verb: 'CONFIRM', senderPhone: '+201099999999' },
      expect.objectContaining({ removeOnComplete: { age: 86_400 } }),
    );
  });

  it('routes single-store WHATSAPP_FORWARD media with caption phone parsing and alerts on multi-store ambiguity', async () => {
    const { controller, prisma, proofQueue, repliesQueue } = makeController();

    prisma.seller.findMany.mockResolvedValueOnce([
      { id: 'seller_1', channels: [{ id: 'chan_fwd_1' }] },
    ]);

    await controller.handleEvent({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'alert_pn_1' },
                messages: [
                  {
                    id: 'wamid.fwd1',
                    from: '201099999999',
                    timestamp: '1764151200',
                    type: 'image',
                    image: { id: 'media_1', caption: 'عميل 01012345678' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(proofQueue.add).toHaveBeenCalledWith(
      'ingest-whatsapp-media',
      expect.objectContaining({
        sellerId: 'seller_1',
        channelId: 'chan_fwd_1',
        customerPhone: '+201012345678',
        isForwardedByOwner: true,
        replyToPhone: '+201099999999',
      }),
      expect.objectContaining({
        jobId: 'wamid:wamid.fwd1',
        removeOnComplete: { age: 86_400 },
      }),
    );

    prisma.seller.findMany.mockResolvedValueOnce([
      { id: 'seller_1', channels: [{ id: 'c1' }] },
      { id: 'seller_2', channels: [{ id: 'c2' }] },
    ]);

    await controller.handleEvent({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'alert_pn_1' },
                messages: [
                  {
                    id: 'wamid.fwd2',
                    from: '201099999999',
                    timestamp: '1764151200',
                    type: 'image',
                    image: { id: 'media_2' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(repliesQueue.add).toHaveBeenCalledWith('forwarder-ambiguous-seller', {
      senderPhone: '+201099999999',
      sellerCount: 2,
    });
  });

  it('enqueues customer receipt images on DEDICATED channels with 24h completion retention', async () => {
    const { controller, prisma, proofQueue } = makeController();
    prisma.channel.findUnique.mockResolvedValue({
      id: 'chan_1',
      sellerId: 'seller_1',
      isActive: true,
    });

    await controller.handleEvent({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'ded_pn_1' },
                contacts: [{ wa_id: '201012345678', profile: { name: 'Sara' } }],
                messages: [
                  {
                    id: 'wamid.cust1',
                    from: '201012345678',
                    timestamp: '1764151200',
                    type: 'document',
                    document: { id: 'doc_1', mime_type: 'image/png' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(proofQueue.add).toHaveBeenCalledWith(
      'ingest-whatsapp-media',
      expect.objectContaining({
        sellerId: 'seller_1',
        channelId: 'chan_1',
        customerPhone: '+201012345678',
        customerDisplayName: 'Sara',
        mediaId: 'doc_1',
        mimeType: 'image/png',
      }),
      expect.objectContaining({
        jobId: 'wamid:wamid.cust1',
        removeOnComplete: { age: 86_400 },
      }),
    );
  });
});
