import { InjectQueue } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { DecisionActor } from '../../generated/prisma/client.js';
import { Queue } from 'bullmq';
import { timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import { ManualOverrideService } from '../../matching/manual-override.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          id: string;
          from: string;
          timestamp: string;
          type: string;
          image?: { id: string; mime_type?: string; url?: string };
          document?: { id: string; mime_type?: string; url?: string; filename?: string };
          button?: { payload?: string; text?: string };
          interactive?: { button_reply?: { id?: string } };
        }>;
      };
    }>;
  }>;
}

@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);
  private readonly verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';
  private readonly alertPhoneNumberId = process.env.TAMAM_ALERT_PHONE_NUMBER_ID ?? '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly manualOverride: ManualOverrideService,
    @InjectQueue('proof-ingest') private readonly proofQueue: Queue,
  ) {}

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
        if (change.field !== 'messages') continue;
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId || !value?.messages?.length) continue;

        // Route 1: Owner quick-reply button taps on Tamam's alert number
        if (phoneNumberId === this.alertPhoneNumberId) {
          for (const msg of value.messages) {
            await this.handleOwnerAction(msg);
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

          const customerPhone = msg.from.startsWith('+') ? msg.from : `+${msg.from}`;
          const receivedAt = new Date(Number(msg.timestamp) * 1000).toISOString();

          // Pass mediaId only (not base64) to keep Redis memory flat under bursts
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
              jobId: `wamid:${msg.id}`, // Meta webhook duplicate protection
              attempts: 4,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: 500,
            },
          );
        }
      }
    }

    return { ok: true };
  }

  private extractReceiptMedia(msg: {
    type: string;
    image?: { id: string; mime_type?: string; url?: string };
    document?: { id: string; mime_type?: string; url?: string };
  }): { id: string; url?: string; mimeType: string } | null {
    if (msg.type === 'image' && msg.image?.id) {
      return {
        id: msg.image.id,
        url: msg.image.url,
        mimeType: msg.image.mime_type ?? 'image/jpeg',
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
      };
    }

    return null;
  }

  private async handleOwnerAction(msg: {
    from: string;
    type: string;
    button?: { payload?: string };
    interactive?: { button_reply?: { id?: string } };
  }): Promise<void> {
    const actionPayload =
      msg.type === 'button'
        ? msg.button?.payload
        : msg.type === 'interactive'
          ? msg.interactive?.button_reply?.id
          : undefined;

    if (!actionPayload) return;

    const match = actionPayload.match(/^(CONFIRM|REJECT):([a-z0-9]+)$/i);
    if (!match) return;

    const [, verb, proofId] = match;
    const senderPhone = msg.from.startsWith('+') ? msg.from : `+${msg.from}`;

    // Verify sender is the seller's owner or an active team member for that proof
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      include: {
        seller: {
          select: {
            id: true,
            ownerPhone: true,
            members: { where: { phone: senderPhone, isActive: true }, select: { id: true, role: true } },
          },
        },
      },
    });
    if (!proof) return;

    const isOwner = proof.seller.ownerPhone === senderPhone;
    const member = proof.seller.members[0];
    if (!isOwner && !member) {
      this.logger.warn(`Unauthorized WhatsApp action attempt from ${senderPhone} on proof=${proofId}`);
      return;
    }

    const actorRole = isOwner ? DecisionActor.OWNER : (member.role as DecisionActor);
    const actorId = member?.id ?? proof.seller.id;

    if (verb.toUpperCase() === 'CONFIRM') {
      await this.manualOverride.confirmProof({
        sellerId: proof.sellerId,
        proofId: proof.id,
        actorRole,
        actorId,
        note: 'Confirmed via WhatsApp alert button',
      });
    } else {
      await this.manualOverride.rejectProof({
        sellerId: proof.sellerId,
        proofId: proof.id,
        actorRole,
        actorId,
        isFraud: true,
        note: 'Rejected via WhatsApp alert button',
      });
    }
  }
}