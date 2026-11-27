import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { WhatsAppApiClient } from '../channels/whatsapp/whatsapp-api.client.js';
import { parseCairoTimestampToUtc } from '../common/cairo-time.js';
import { CryptoService } from '../common/crypto.service.js';
import { normalizeName, normalizeRef, parseAmountToPiasters } from '../common/normalize.js';
import { Prisma, ProofStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { prepareReceiptImage } from './utils/image-pipeline.js';
import { VISION_PROVIDER, type VisionProvider } from './vision/vision-provider.interface.js';

export interface ProofIngestJobData {
  sellerId: string;
  customerPhone: string | null;
  customerDisplayName?: string;
  channelMessageId: string;
  imageBase64?: string; // Downloaded by WhatsApp webhook or passed from dashboard test
  channelId?: string;
  mediaId?: string;
  directUrl?: string;
  mimeType?: string;
  imageKey?: string;
  isForwardedByOwner?: boolean;
  replyToPhone?: string;
  receivedAt: string; // ISO UTC
}

@Processor('proof-ingest', { concurrency: 5 })
export class ProofIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(ProofIngestProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(VISION_PROVIDER) private readonly vision: VisionProvider,
    @InjectQueue('matching') private readonly matchingQueue: Queue,
    @InjectQueue('replies') private readonly repliesQueue: Queue,
    @Optional() private readonly crypto?: CryptoService,
    @Optional() private readonly whatsappApi?: WhatsAppApiClient,
  ) {
    super();
  }

  async process(job: Job<ProofIngestJobData>): Promise<void> {
    const { sellerId, customerPhone, customerDisplayName, channelMessageId } = job.data;

    // 1. Idempotency check
    const existing = await this.prisma.proof.findUnique({
      where: { channelMessageId },
      select: { id: true },
    });
    if (existing) return;

    // 2. Sharp downsampling, SHA-256, 64-bit dHash, and EXIF check
    let rawBuffer: Buffer;
    if (job.data.imageBase64) {
      rawBuffer = Buffer.from(job.data.imageBase64, 'base64');
    } else if (job.data.mediaId && job.data.channelId) {
      if (!this.crypto || !this.whatsappApi) {
        throw new Error('CryptoService and WhatsAppApiClient are required to download media');
      }
      const channel = await this.prisma.channel.findUniqueOrThrow({
        where: { id: job.data.channelId },
        select: { encryptedToken: true },
      });
      if (!channel.encryptedToken) {
        throw new Error(`Channel ${job.data.channelId} has no encryptedToken`);
      }
      const token = this.crypto.decrypt(channel.encryptedToken);
      const downloaded = await this.whatsappApi.downloadMedia({
        accessToken: token,
        mediaId: job.data.mediaId,
        directUrl: job.data.directUrl,
      });
      rawBuffer = downloaded.buffer;
    } else {
      return;
    }
    const prepared = await prepareReceiptImage(rawBuffer);

    // 3. Vision extraction
    const extraction = await this.vision.extractReceipt(prepared.resizedJpeg, 'image/jpeg');
    const data = extraction.data;

    // 4. Noise gate: silently ignore non-receipt images (products, size charts, etc.)
    if (!data.isPaymentReceipt || data.receiptConfidence < 0.55) {
      this.logger.debug(
        `Dropped non-receipt media msg=${channelMessageId} conf=${data.receiptConfidence}`,
      );
      return;
    }

    // 5. Upload compact JPEG only for confirmed receipts
    const imageKey = `proofs/${sellerId}/${channelMessageId}.jpg`;
    await this.storage.putReceiptImage(imageKey, prepared.resizedJpeg);

    const amountPiasters = data.amountEgp ? parseAmountToPiasters(data.amountEgp) : null;
    const normalizedRef = normalizeRef(data.reference);
    const normalizedSender = normalizeName(data.senderName);
    const extractedTime = parseCairoTimestampToUtc(data.timestampLocal);
    const unreadable = !data.isReadable || !amountPiasters || amountPiasters <= 0n;

    // 6. Upsert customer (when known) + create Proof
    const customer = customerPhone
      ? await this.prisma.customer.upsert({
          where: { sellerId_phone: { sellerId, phone: customerPhone } },
          update: customerDisplayName ? { displayName: customerDisplayName } : {},
          create: { sellerId, phone: customerPhone, displayName: customerDisplayName },
        })
      : null;

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

    // 7. Hand off to serialized per-seller matching engine (Slice 4)
    await this.matchingQueue.add(
      'match-proof',
      { sellerId, proofId },
      { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    );
  }
}