import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { createHash } from 'crypto';
import type { Redis } from 'ioredis';
import { WhatsAppApiClient } from '../channels/whatsapp/whatsapp-api.client.js';
import { parseCairoTimestampToUtc } from '../common/cairo-time.js';
import { CryptoService } from '../common/crypto.service.js';
import { normalizeName, normalizeRef, parseAmountToPiasters } from '../common/normalize.js';
import { Prisma, ProofStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  MAX_IMAGE_BYTES,
  PreparedImage,
  TinyStickerError,
  prepareReceiptImage,
} from './utils/image-pipeline.js';
import {
  VISION_PROVIDER,
  type VisionProvider,
  VisionProviderOutput,
} from './vision/vision-provider.interface.js';

export interface ProofIngestJobData {
  sellerId: string;
  customerPhone: string | null;
  customerDisplayName?: string;
  channelMessageId: string;
  imageBase64?: string;
  channelId?: string;
  mediaId?: string;
  directUrl?: string;
  mimeType?: string;
  imageKey?: string;
  isForwardedByOwner?: boolean;
  replyToPhone?: string;
  receivedAt: string; // ISO UTC
}

@Processor('proof-ingest', { concurrency: 3 })
export class ProofIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(ProofIngestProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(VISION_PROVIDER) private readonly vision: VisionProvider,
    @InjectQueue('matching') private readonly matchingQueue: Queue,
    @InjectQueue('replies') private readonly repliesQueue: Queue,
    private readonly crypto: CryptoService,
    private readonly whatsappApi: WhatsAppApiClient,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {
    super();
  }

  async process(job: Job<ProofIngestJobData>): Promise<void> {
    const { sellerId, customerPhone, customerDisplayName, channelMessageId } = job.data;

    // 0. Skip previously dropped non-receipt wamid retries (24h cache)
    if (this.redis && (await this.redis.exists(`wamid:drop:${channelMessageId}`))) {
      return;
    }

    // 1. Idempotency check
    const existing = await this.prisma.proof.findUnique({
      where: { channelMessageId },
      select: { id: true },
    });
    if (existing) return;

    // 2. Per-customer hourly Vision abuse guard (exempting staff WHATSAPP_FORWARD)
    if (this.redis && !job.data.isForwardedByOwner && customerPhone) {
      const rateKey = `vision:sender:${customerPhone}`;
      const hits = await this.redis.incr(rateKey);
      if (hits === 1) {
        await this.redis.expire(rateKey, 3600);
      }
      if (hits > 20) {
        await this.prisma.auditLog.create({
          data: {
            sellerId,
            entityType: 'PROOF',
            entityId: channelMessageId,
            action: 'VISION_RATE_LIMITED',
            actorType: 'SYSTEM',
            payload: { customerPhone, hits },
          },
        });
        return;
      }
    }

    // 3. Download or decode image bytes
    let rawBuffer: Buffer;
    if (job.data.imageKey) {
      rawBuffer = await this.storage.getReceiptImage(job.data.imageKey);
    } else if (job.data.imageBase64) {
      rawBuffer = Buffer.from(job.data.imageBase64, 'base64');
    } else if (job.data.mediaId && job.data.channelId) {
      const channel = await this.prisma.channel.findUniqueOrThrow({
        where: { id: job.data.channelId },
        select: { type: true, encryptedToken: true },
      });
      const token = channel.encryptedToken
        ? this.crypto.decrypt(channel.encryptedToken)
        : (process.env.TAMAM_ALERT_ACCESS_TOKEN ?? '');
      if (!token) {
        throw new UnrecoverableError(`Channel ${job.data.channelId} has no media access token`);
      }
      const downloaded = await this.whatsappApi.downloadMedia({
        accessToken: token,
        mediaId: job.data.mediaId,
        directUrl: job.data.directUrl,
      });
      rawBuffer = downloaded.buffer;
    } else {
      return;
    }

    // 4. Validate bounds, downsample, hash, and detect EXIF forensics
    let prepared: PreparedImage;
    try {
      if (rawBuffer.length > MAX_IMAGE_BYTES) {
        throw new Error('Image exceeds 10 MB limit');
      }
      prepared = await prepareReceiptImage(rawBuffer);
    } catch (err) {
      if (err instanceof TinyStickerError) {
        return;
      }

      const rawSha256 = createHash('sha256').update(rawBuffer).digest('hex');
      const customer = await this.upsertCustomer(sellerId, customerPhone, customerDisplayName);
      const proof = await this.createProofSafe({
        sellerId,
        customerId: customer?.id ?? null,
        channelId: job.data.channelId ?? null,
        channelMessageId,
        isForwarded: job.data.isForwardedByOwner ?? false,
        replyToPhone: job.data.replyToPhone ?? customerPhone,
        imageKey: null,
        imageSha256: rawSha256,
        imagePhash: null,
        status: ProofStatus.UNMATCHED,
        statusReason: 'UNREADABLE_IMAGE',
      });

      const recipientPhone = job.data.replyToPhone ?? customerPhone;
      if (proof && recipientPhone) {
        await this.repliesQueue.add('customer-unreadable', {
          sellerId,
          customerPhone: recipientPhone,
          proofId: proof.id,
        });
      }
      throw new UnrecoverableError((err as Error).message);
    }

    // 5. Vision extraction with final-retry fallback
    let extraction: VisionProviderOutput;
    try {
      extraction = await this.vision.extractReceipt(prepared.resizedJpeg, 'image/jpeg');
    } catch (err) {
      const maxAttempts = job.opts?.attempts ?? 1;
      if (job.attemptsMade + 1 >= maxAttempts) {
        await this.handleVisionUnavailable(job.data, prepared);
        return;
      }
      throw err;
    }

    const data = extraction.data;

    // 6. Noise gate: cache non-receipt wamid for 24h without saving Proof or S3 object
    if (!data.isPaymentReceipt || data.receiptConfidence < 0.55) {
      this.logger.debug(
        `Dropped non-receipt media msg=${channelMessageId} conf=${data.receiptConfidence}`,
      );
      if (this.redis) {
        await this.redis.set(`wamid:drop:${channelMessageId}`, '1', 'EX', 86_400);
      }
      return;
    }

    // 7. Upload compact JPEG (unless already stored via imageKey)
    const imageKey = job.data.imageKey ?? `proofs/${sellerId}/${channelMessageId}.jpg`;
    const uploadedNewObject = !job.data.imageKey;
    if (uploadedNewObject) {
      await this.storage.putReceiptImage(imageKey, prepared.resizedJpeg);
    }

    const amountPiasters = data.amountEgp ? parseAmountToPiasters(data.amountEgp) : null;
    const normalizedRef = normalizeRef(data.reference);
    const normalizedSender = normalizeName(data.senderName);
    const extractedTime = parseCairoTimestampToUtc(data.timestampLocal) ?? null;
    const unreadable = !data.isReadable || !amountPiasters || amountPiasters <= 0n;

    // 8. Upsert customer (when known) + create Proof
    const customer = await this.upsertCustomer(sellerId, customerPhone, customerDisplayName);

    let proofId: string;
    try {
      const proof = await this.prisma.proof.create({
        data: {
          sellerId,
          customerId: customer?.id ?? null,
          channelId: job.data.channelId ?? null,
          channelMessageId,
          isForwarded: job.data.isForwardedByOwner ?? false,
          replyToPhone: job.data.replyToPhone ?? customerPhone,
          visionCostMicroUsd: extraction.estimatedCostMicroUsd,
          imageKey,
          imageSha256: prepared.sha256,
          imagePhash: prepared.phash64,
          extractedAmountPiasters: amountPiasters,
          extractedRef: normalizedRef,
          extractedTime,
          extractedSender: normalizedSender,
          extractedMethod: data.paymentMethod,
          extractionConfidence: data.receiptConfidence,
          extractionRaw: {
            provider: extraction.provider,
            model: extraction.model,
            latencyMs: extraction.latencyMs,
            fields: data,
            forensics: prepared.forensics,
          } as unknown as Prisma.InputJsonValue,
          status: unreadable ? ProofStatus.UNMATCHED : ProofStatus.PROCESSING,
          statusReason: unreadable ? 'UNREADABLE_IMAGE' : null,
        },
      });
      proofId = proof.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return;
      }
      if (uploadedNewObject) {
        await this.storage.deleteObject(imageKey).catch(() => undefined);
      }
      throw err;
    }

    if (unreadable) {
      const recipientPhone = job.data.replyToPhone ?? customerPhone;
      if (recipientPhone) {
        await this.repliesQueue.add('customer-unreadable', {
          sellerId,
          customerPhone: recipientPhone,
          proofId,
        });
      }
      return;
    }

    // 9. Hand off to serialized per-seller matching engine
    await this.matchingQueue.add(
      'match-proof',
      { sellerId, proofId },
      { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    );
  }

  private async upsertCustomer(
    sellerId: string,
    customerPhone: string | null,
    customerDisplayName?: string,
  ): Promise<{ id: string } | null> {
    if (!customerPhone) return null;
    return this.prisma.customer.upsert({
      where: { sellerId_phone: { sellerId, phone: customerPhone } },
      update: customerDisplayName ? { displayName: customerDisplayName } : {},
      create: { sellerId, phone: customerPhone, displayName: customerDisplayName },
      select: { id: true },
    });
  }

  private async createProofSafe(data: Prisma.ProofUncheckedCreateInput): Promise<{ id: string } | null> {
    try {
      return await this.prisma.proof.create({ data, select: { id: true } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return null;
      }
      throw err;
    }
  }

  private async handleVisionUnavailable(
    jobData: ProofIngestJobData,
    prepared: PreparedImage,
  ): Promise<void> {
    const { sellerId, customerPhone, customerDisplayName, channelMessageId } = jobData;
    const imageKey = jobData.imageKey ?? `proofs/${sellerId}/${channelMessageId}.jpg`;
    const uploadedNewObject = !jobData.imageKey;
    if (uploadedNewObject) {
      await this.storage.putReceiptImage(imageKey, prepared.resizedJpeg);
    }

    const customer = await this.upsertCustomer(sellerId, customerPhone, customerDisplayName);
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { ownerPhone: true },
    });

    let proof: { id: string } | null;
    try {
      proof = await this.createProofSafe({
        sellerId,
        customerId: customer?.id ?? null,
        channelId: jobData.channelId ?? null,
        channelMessageId,
        isForwarded: jobData.isForwardedByOwner ?? false,
        replyToPhone: jobData.replyToPhone ?? customerPhone,
        visionCostMicroUsd: null,
        imageKey,
        imageSha256: prepared.sha256,
        imagePhash: prepared.phash64,
        status: ProofStatus.UNMATCHED,
        statusReason: 'VISION_UNAVAILABLE',
      });
    } catch (err) {
      if (uploadedNewObject) {
        await this.storage.deleteObject(imageKey).catch(() => undefined);
      }
      throw err;
    }

    if (proof && seller?.ownerPhone) {
      await this.repliesQueue.add('owner-alert', {
        sellerId,
        ownerPhone: seller.ownerPhone,
        proofId: proof.id,
        status: 'UNMATCHED',
        reasonCode: 'VISION_UNAVAILABLE',
      });
    }
  }
}
