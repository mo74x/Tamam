import { InjectQueue } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { ChannelType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EGYPT_CAPTION_PHONE_RE = /(?:\+?20|0)(1[0125]\d{8})/;

interface WebhookMessage {
  id: string;
  from: string;
  to?: string;
  recipient_id?: string;
  timestamp: string;
  type: string;
  image?: { id: string; mime_type?: string; url?: string; caption?: string };
  document?: {
    id: string;
    mime_type?: string;
    url?: string;
    filename?: string;
    caption?: string;
  };
  button?: { payload?: string; text?: string };
  interactive?: { button_reply?: { id?: string } };
}

interface WebhookChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  message_echoes?: WebhookMessage[];
  messages?: WebhookMessage[];
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: WebhookChangeValue;
    }>;
  }>;
}

@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('proof-ingest') private readonly proofQueue: Queue,
    @InjectQueue('matching') private readonly matchingQueue: Queue,
    @InjectQueue('replies') private readonly repliesQueue: Queue,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  private get verifyToken(): string {
    return process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';
  }

  private get alertPhoneNumberId(): string {
    return process.env.TAMAM_ALERT_PHONE_NUMBER_ID ?? '';
  }

  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    const validMode = mode === 'subscribe';
    const tokenBuf = Buffer.from(token ?? '');
    const expectedBuf = Buffer.from(this.verifyToken);
    const validToken =
      expectedBuf.length > 0 &&
      tokenBuf.length === expectedBuf.length &&
      timingSafeEqual(tokenBuf, expectedBuf);

    if (!validMode || !validToken) {
      throw new ForbiddenException('Webhook verification failed');
    }

    res.status(HttpStatus.OK).type('text/plain').send(challenge);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(WhatsAppSignatureGuard)
  async handleEvent(@Body() payload: MetaWebhookPayload): Promise<{ ok: true }> {
    if (payload.object !== 'whatsapp_business_account') {
      return { ok: true };
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // Track seller manual replies on WhatsApp Coexistence numbers for 15m suppression
        if (change.field === 'smb_message_echoes') {
          await this.handleCoexistenceEchoes(phoneNumberId, value);
          continue;
        }

        if (change.field !== 'messages' || !value?.messages?.length) continue;

        // Route 1: Tamam shared alert number (owner action buttons + forwarded receipts)
        if (this.alertPhoneNumberId && phoneNumberId === this.alertPhoneNumberId) {
          for (const msg of value.messages) {
            await this.handleAlertNumberMessage(msg);
          }
          continue;
        }

        // Route 2: Customer receipt images on a seller's connected WhatsApp channel
        const channel = await this.prisma.channel.findUnique({
          where: { phoneNumberId },
          select: { id: true, sellerId: true, isActive: true },
        });
        if (!channel?.isActive) continue;

        const nameByWaId = new Map(
          (value.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name]),
        );

        for (const msg of value.messages) {
          const media = this.extractReceiptMedia(msg);
          if (!media) continue;

          const customerPhone = this.normalizeE164(msg.from);
          const receivedAt = new Date(Number(msg.timestamp) * 1000).toISOString();

          await this.proofQueue.add(
            'ingest-whatsapp-media',
            {
              sellerId: channel.sellerId,
              channelId: channel.id,
              customerPhone,
              customerDisplayName: nameByWaId.get(msg.from),
              channelMessageId: msg.id,
              mediaId: media.id,
              directUrl: media.url,
              mimeType: media.mimeType,
              receivedAt,
            },
            {
              jobId: `wamid:${msg.id}`,
              attempts: 4,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: { age: 86_400 },
            },
          );
        }
      }
    }

    return { ok: true };
  }

  private normalizeE164(waId: string): string {
    return waId.startsWith('+') ? waId : `+${waId}`;
  }

  private async handleCoexistenceEchoes(
    phoneNumberId: string,
    value: WebhookChangeValue | undefined,
  ): Promise<void> {
    if (!this.redis) return;

    const echoes = value?.message_echoes ?? value?.messages ?? [];
    if (echoes.length === 0) return;

    const channel = await this.prisma.channel.findUnique({
      where: { phoneNumberId },
      select: { sellerId: true, isActive: true, type: true },
    });
    if (!channel?.isActive || channel.type !== ChannelType.WHATSAPP_COEXISTENCE) {
      return;
    }

    for (const echo of echoes) {
      const rawCustomer = echo.to ?? echo.recipient_id ?? value?.contacts?.[0]?.wa_id;
      if (!rawCustomer) continue;
      const customerPhone = this.normalizeE164(rawCustomer);
      await this.redis.set(
        `coexistence:echo:${channel.sellerId}:${customerPhone}`,
        '1',
        'EX',
        900,
      );
    }
  }

  private extractReceiptMedia(msg: WebhookMessage): {
    id: string;
    url?: string;
    mimeType: string;
    caption?: string;
  } | null {
    if (msg.type === 'image' && msg.image?.id) {
      return {
        id: msg.image.id,
        url: msg.image.url,
        mimeType: msg.image.mime_type ?? 'image/jpeg',
        caption: msg.image.caption,
      };
    }

    // Customers frequently send receipts as WhatsApp Documents to preserve sharpness
    if (
      msg.type === 'document' &&
      msg.document?.id &&
      msg.document.mime_type &&
      IMAGE_MIMES.has(msg.document.mime_type)
    ) {
      return {
        id: msg.document.id,
        url: msg.document.url,
        mimeType: msg.document.mime_type,
        caption: msg.document.caption,
      };
    }

    return null;
  }

  private async handleAlertNumberMessage(msg: WebhookMessage): Promise<void> {
    const senderPhone = this.normalizeE164(msg.from);

    if (this.redis) {
      await this.redis.set(`alert:owner-window:${senderPhone}`, '1', 'EX', 84_600);
    }

    const actionPayload =
      msg.type === 'button'
        ? msg.button?.payload
        : msg.type === 'interactive'
          ? msg.interactive?.button_reply?.id
          : undefined;

    if (actionPayload) {
      const match = actionPayload.match(/^(CONFIRM|REJECT):([a-z0-9]+)$/i);
      if (!match) return;

      const [, verb, proofId] = match;
      await this.matchingQueue.add(
        'owner-action',
        { proofId, verb: verb.toUpperCase(), senderPhone },
        { removeOnComplete: { age: 86_400 } },
      );
      return;
    }

    const media = this.extractReceiptMedia(msg);
    if (!media) return;

    const forwardSellers = await this.prisma.seller.findMany({
      where: {
        channels: { some: { type: ChannelType.WHATSAPP_FORWARD, isActive: true } },
        OR: [
          { ownerPhone: senderPhone },
          { members: { some: { phone: senderPhone, isActive: true } } },
        ],
      },
      select: {
        id: true,
        channels: {
          where: { type: ChannelType.WHATSAPP_FORWARD, isActive: true },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (forwardSellers.length === 0) {
      this.logger.debug(`Ignored alert-number media from unregistered sender ${senderPhone}`);
      return;
    }

    if (forwardSellers.length > 1) {
      await this.repliesQueue.add('forwarder-ambiguous-seller', {
        senderPhone,
        sellerCount: forwardSellers.length,
      });
      return;
    }

    const target = forwardSellers[0];
    const channelId = target.channels[0]?.id;
    if (!channelId) return;

    const captionMatch = (media.caption ?? '').match(EGYPT_CAPTION_PHONE_RE);
    const customerPhone = captionMatch ? `+20${captionMatch[1]}` : null;
    const receivedAt = new Date(Number(msg.timestamp) * 1000).toISOString();

    await this.proofQueue.add(
      'ingest-whatsapp-media',
      {
        sellerId: target.id,
        channelId,
        customerPhone,
        channelMessageId: msg.id,
        mediaId: media.id,
        directUrl: media.url,
        mimeType: media.mimeType,
        isForwardedByOwner: true,
        replyToPhone: senderPhone,
        receivedAt,
      },
      {
        jobId: `wamid:${msg.id}`,
        attempts: 4,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 86_400 },
      },
    );
  }
}
