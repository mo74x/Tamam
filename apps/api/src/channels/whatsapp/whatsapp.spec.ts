import { createHmac } from 'crypto';
import { ProofStatus } from '../../generated/prisma/client.js';
import { RepliesProcessor } from '../../replies/replies.processor.js';
import { WhatsAppApiClient } from './whatsapp-api.client.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';

describe('WhatsApp Webhook Security, ApiClient & Debounced Replies', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.META_APP_SECRET;
  });

  it('validates X-Hub-Signature-256 against raw body bytes dynamically', () => {
    process.env.META_APP_SECRET = 'test_app_secret_123';
    const guard = new WhatsAppSignatureGuard();
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}', 'utf8');
    const validSig = `sha256=${createHmac('sha256', 'test_app_secret_123').update(rawBody).digest('hex')}`;

    const makeCtx = (sig: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ rawBody, headers: { 'x-hub-signature-256': sig } }),
        }),
      }) as never;

    expect(guard.canActivate(makeCtx(validSig))).toBe(true);
    expect(() => guard.canActivate(makeCtx('sha256=deadbeef'))).toThrow();
  });

  it('strips Authorization header on non-graph CDN hosts and blocks untrusted URLs', async () => {
    const client = new WhatsAppApiClient();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '4' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });
    globalThis.fetch = fetchMock as never;

    const dl = await client.downloadMedia({
      accessToken: 'secret-token',
      mediaId: 'm1',
      directUrl: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
    });
    expect(dl.buffer).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
      expect.objectContaining({ headers: {}, redirect: 'error' }),
    );

    await expect(
      client.downloadMedia({
        accessToken: 'secret-token',
        mediaId: 'm1',
        directUrl: 'https://evil.example.com/receipt.jpg',
      }),
    ).rejects.toThrow(/Untrusted media host/);
  });

  it('verifies connected phone number via Meta Graph API', async () => {
    const client = new WhatsAppApiClient();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ verified_name: 'Tamam Store', display_phone_number: '+20 100 000 0000' }),
    }) as never;

    const info = await client.verifyPhoneNumber('pn_123', 'tok_abc');
    expect(info).toEqual({ verifiedName: 'Tamam Store', displayPhoneNumber: '+20 100 000 0000' });
  });

  it('skips sending debounced WAITING reply if proof already transitioned to CONFIRMED', async () => {
    const prisma = {
      proof: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'proof_1',
          status: ProofStatus.CONFIRMED,
          statusReason: null,
          waitingReplySent: false,
          isForwarded: false,
          replyToPhone: null,
          channelMessageId: 'wamid.123',
          createdAt: new Date(),
          channel: null,
          seller: {
            ownerPhone: '+201099999999',
            replyTemplates: null,
            channels: [{ phoneNumberId: '1', encryptedToken: 'enc', type: 'WHATSAPP_DEDICATED' }],
          },
        }),
        update: vi.fn(),
      },
    };
    const whatsapp = { sendTextMessage: vi.fn() };
    const crypto = { decrypt: vi.fn().mockReturnValue('tok') };
    const redis = { exists: vi.fn().mockResolvedValue(0) };

    const processor = new RepliesProcessor(
      prisma as never,
      crypto as never,
      whatsapp as never,
      redis as never,
    );
    await processor.process({
      name: 'customer-waiting',
      data: { sellerId: 's1', customerPhone: '+201000000000', proofId: 'proof_1' },
    } as never);

    expect(whatsapp.sendTextMessage).not.toHaveBeenCalled();
    expect(prisma.proof.update).not.toHaveBeenCalled();
  });
});
