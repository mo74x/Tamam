import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { EvidenceSource } from '../generated/prisma/client.js';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { classifyNoise } from './utils/otp-filter.js';

export interface EnqueueEvidenceInput {
  sellerId: string;
  source: EvidenceSource;
  senderApp: string | null;
  rawText: string;
  receivedAt: Date;
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

    const twoMinBucket = Math.floor(input.receivedAt.getTime() / 120_000);
    const dedupeHash = createHash('sha256')
      .update(`${input.sellerId}|${input.rawText.trim()}|${twoMinBucket}`)
      .digest('hex');

    await this.evidenceQueue.add(
      'parse-and-store',
      {
        ...input,
        receivedAt: input.receivedAt.toISOString(),
        dedupeHash,
      },
      {
        jobId: dedupeHash, // BullMQ drops duplicate retries automatically
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
      },
    );

    return { accepted: true, dedupeHash };
  }
}