import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { EvidenceSource } from '../generated/prisma/client.js';
import { EvidenceService } from './evidence.service.js';
import { SellerTokenGuard } from './guards/seller-token.guard.js';

const IngestEvidenceSchema = z.object({
  source: z
    .enum([EvidenceSource.ANDROID_NOTIF, EvidenceSource.SMS_FORWARD])
    .default(EvidenceSource.ANDROID_NOTIF),
  senderApp: z.string().max(120).optional(),
  rawText: z.string().min(8).max(2000),
  receivedAt: z.string().datetime().optional(), // ISO UTC from Android device
  clientEventId: z.string().min(1).max(128).optional(),
  deviceId: z.string().cuid().optional(),
});

@Controller('webhooks/evidence')
export class EvidenceController {
  constructor(private readonly evidenceService: EvidenceService) {}

  @Post(':sellerId')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SellerTokenGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async ingest(
    @Param('sellerId') sellerId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
    @Req() req?: { deviceId?: string },
  ) {
    const parsed = IngestEvidenceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const idempotencyKey =
      idempotencyKeyHeader?.trim() || parsed.data.clientEventId || undefined;

    return this.evidenceService.enqueueEvidence({
      sellerId,
      source: parsed.data.source,
      senderApp: parsed.data.senderApp ?? null,
      rawText: parsed.data.rawText,
      receivedAt: parsed.data.receivedAt ? new Date(parsed.data.receivedAt) : new Date(),
      idempotencyKey,
      deviceId: parsed.data.deviceId ?? req?.deviceId ?? null,
    });
  }
}
