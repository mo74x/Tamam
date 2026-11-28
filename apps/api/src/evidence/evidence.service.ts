import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { toAsciiDigits } from '../common/normalize.js';
import { EvidenceSource } from '../generated/prisma/client.js';
import { classifyNoise } from './utils/otp-filter.js';

export interface EnqueueEvidenceInput {
  sellerId: string;
  source: EvidenceSource;
  senderApp: string | null;
  rawText: string;
  receivedAt: Date;
  idempotencyKey?: string;
  deviceId?: string | null;
}

@Injectable()
export class EvidenceService {
  constructor(
    @InjectQueue('evidence-ingest') private readonly evidenceQueue: Queue,
  ) {}

  async enqueueEvidence(input: EnqueueEvidenceInput) {
    const noise = classifyNoise(input.rawText);
    if (noise !== 'OK') {
      return { accepted: false, reason: noise };
    }

    const normalizedText = toAsciiDigits(input.rawText).replace(/\s+/g, ' ').trim();
    let dedupeHash: string;

    if (input.idempotencyKey) {
      const textHash = createHash('sha256').update(normalizedText).digest('hex');
      dedupeHash = createHash('sha256')
        .update(`${input.sellerId}:${input.idempotencyKey}:${textHash}`)
        .digest('hex');
    } else {
      const twoMinBucket = Math.floor(input.receivedAt.getTime() / 120_000);
      dedupeHash = createHash('sha256')
        .update(`${input.sellerId}|${normalizedText}|${twoMinBucket}`)
        .digest('hex');
    }

    await this.evidenceQueue.add(
      'parse-and-store',
      {
        sellerId: input.sellerId,
        source: input.source,
        senderApp: input.senderApp,
        rawText: input.rawText,
        receivedAt: input.receivedAt.toISOString(),
        dedupeHash,
        deviceId: input.deviceId ?? null,
      },
      {
        jobId: dedupeHash,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
      },
    );

    return { accepted: true, dedupeHash };
  }
}
