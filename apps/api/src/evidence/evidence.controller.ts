import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { EvidenceSource } from '../generated/prisma/client.js';
import { z } from 'zod';
import { EvidenceService } from './evidence.service.js';
import { SellerTokenGuard } from './guards/seller-token.guard.js';

const IngestEvidenceSchema = z.object({
  source: z.nativeEnum(EvidenceSource).default(EvidenceSource.ANDROID_NOTIF),
  senderApp: z.string().max(120).optional(),
  rawText: z.string().min(8).max(2000),
  receivedAt: z.string().datetime().optional(), // ISO UTC from Android device
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
  ) {
    const parsed = IngestEvidenceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.evidenceService.enqueueEvidence({
      sellerId,
      source: parsed.data.source,
      senderApp: parsed.data.senderApp ?? null,
      rawText: parsed.data.rawText,
      receivedAt: parsed.data.receivedAt ? new Date(parsed.data.receivedAt) : new Date(),
    });
  }
}