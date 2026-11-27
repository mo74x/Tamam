import { createHmac } from 'crypto';
import { ProofStatus } from '../../generated/prisma/client.js';
import { RepliesProcessor } from '../../replies/replies.processor.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';

describe('WhatsApp Webhook Security & Debounced Replies', () => {
  it('validates X-Hub-Signature-256 against raw body bytes', () => {
    process.env.META_APP_SECRET = 'test_app_secret_123';
    const guard = new WhatsAppSignatureGuard();
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}', 'utf8');
    const validSig = `sha256=${createHmac('sha256', 'test_app_secret_123').update(rawBody).digest('hex')}`;

    const makeCtx = (sig: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ rawBody, headers: { 'x-hub-signature-256': sig } }),
        }),
      }) as any;

    expect(guard.canActivate(makeCtx(validSig))).toBe(true);
    expect(() => guard.canActivate(makeCtx('sha256=deadbeef'))).toThrow();
  });

  it('skips sending debounced WAITING reply if proof already transitioned to CONFIRMED', async () => {
    const prisma = {
      proof: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'proof_1',
          status: ProofStatus.CONFIRMED,
          waitingReplySent: false,
          channelMessageId: 'wamid.123',
          seller: { replyTemplates: null, channels: [{ phoneNumberId: '1', encryptedToken: 'enc' }] },
        }),
        update: vi.fn(),
      },
    };
    const whatsapp = { sendTextMessage: vi.fn() };
    const crypto = { decrypt: vi.fn().mockReturnValue('tok') };

    const processor = new RepliesProcessor(prisma as any, crypto as any, whatsapp as any);
    await processor.process({
      name: 'customer-waiting',
      data: { sellerId: 's1', customerPhone: '+201000000000', proofId: 'proof_1' },
    } as any);

    expect(whatsapp.sendTextMessage).not.toHaveBeenCalled();
    expect(prisma.proof.update).not.toHaveBeenCalled();
  });
});