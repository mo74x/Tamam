import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { EvidenceSource, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ParserRegistryService } from './parsers/parser-registry.service.js';

export interface EvidenceJobData {
  sellerId: string;
  source: EvidenceSource;
  senderApp: string | null;
  rawText: string;
  receivedAt: string;
  dedupeHash: string;
  deviceId?: string | null;
}

const PERSONAL_MSISDN_PATTERN = /^\+?2?01\d{9}$/;

@Processor('evidence-ingest')
export class EvidenceIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(EvidenceIngestProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parserRegistry: ParserRegistryService,
    @InjectQueue('matching') private readonly matchingQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<EvidenceJobData>): Promise<void> {
    const { sellerId, source, senderApp, rawText, dedupeHash, deviceId } = job.data;
    const receivedAt = new Date(job.data.receivedAt);

    // Reject personal mobile numbers as automated senders pre-DB to avoid false credits
    const trimmedSender = (senderApp ?? '').trim();
    if (source !== EvidenceSource.MANUAL_PASTE && PERSONAL_MSISDN_PATTERN.test(trimmedSender)) {
      await this.prisma.auditLog.create({
        data: {
          sellerId,
          entityType: 'EVIDENCE',
          entityId: dedupeHash,
          action: 'EVIDENCE_PERSONAL_SENDER_IGNORED',
          actorType: 'SYSTEM',
          payload: { senderApp, source },
        },
      });
      return;
    }

    // Update device heartbeat asynchronously when submitted by an authenticated device
    if (deviceId) {
      void this.prisma.device
        .updateMany({
          where: { id: deviceId, sellerId },
          data: { lastHeartbeatAt: new Date(), offlineAlerted: false },
        })
        .catch((err: unknown) => {
          this.logger.warn(`Failed to update device heartbeat ${deviceId}: ${String(err)}`);
        });
    }

    const parsed = await this.parserRegistry.parse(senderApp, rawText, receivedAt, {
      allowUnscopedFallback: source === EvidenceSource.MANUAL_PASTE,
      sellerId,
    });

    if (!parsed) {
      this.logger.warn(`Unparsed evidence for seller=${sellerId} app=${senderApp}`);
      try {
        await this.prisma.evidence.create({
          data: {
            sellerId,
            source,
            senderApp,
            dedupeHash,
            rawText,
            parsedAmountPiasters: null,
            parsedRef: null,
            parsedTime: null,
            parsedSender: null,
            parserName: 'unparsed',
            parseConfidence: 0,
            receivedAt,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return;
        }
        throw err;
      }

      await this.prisma.auditLog.create({
        data: {
          sellerId,
          entityType: 'EVIDENCE',
          entityId: dedupeHash,
          action: 'EVIDENCE_PARSE_FAILED',
          actorType: 'SYSTEM',
          payload: { senderApp, source, rawLength: rawText.length },
        },
      });
      return;
    }

    const semanticKey = parsed.ref
      ? `${sellerId}:${parsed.ref}:${parsed.amountPiasters.toString()}`
      : null;

    if (!parsed.ref) {
      const windowStart = new Date(receivedAt.getTime() - 180_000);
      const windowEnd = new Date(receivedAt.getTime() + 180_000);
      const crossSourceExisting = await this.prisma.evidence.findFirst({
        where: {
          sellerId,
          source: { not: source },
          parsedAmountPiasters: parsed.amountPiasters,
          parsedSender: parsed.sender ?? null,
          receivedAt: { gte: windowStart, lte: windowEnd },
        },
        select: { id: true, source: true },
      });

      if (crossSourceExisting) {
        await this.prisma.auditLog.create({
          data: {
            sellerId,
            entityType: 'EVIDENCE',
            entityId: crossSourceExisting.id,
            action: 'EVIDENCE_CROSS_SOURCE_DEDUPE',
            actorType: 'SYSTEM',
            payload: {
              dedupeHash,
              incomingSource: source,
              existingSource: crossSourceExisting.source,
              amountPiasters: parsed.amountPiasters.toString(),
            },
          },
        });
        return;
      }
    }

    try {
      const evidence = await this.prisma.evidence.create({
        data: {
          sellerId,
          source,
          senderApp,
          dedupeHash,
          semanticKey,
          rawText,
          parsedAmountPiasters: parsed.amountPiasters,
          parsedRef: parsed.ref,
          parsedTime: parsed.time,
          parsedSender: parsed.sender,
          parserName: parsed.parserName,
          parseConfidence: parsed.confidence,
          receivedAt,
        },
      });

      await this.matchingQueue.add(
        'match-evidence',
        { sellerId, evidenceId: evidence.id },
        { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        if (semanticKey) {
          const existingSemantic = await this.prisma.evidence.findUnique({
            where: { semanticKey },
            select: { id: true },
          });
          if (existingSemantic) {
            await this.prisma.auditLog.create({
              data: {
                sellerId,
                entityType: 'EVIDENCE',
                entityId: existingSemantic.id,
                action: 'EVIDENCE_SEMANTIC_DEDUPE',
                actorType: 'SYSTEM',
                payload: { dedupeHash, semanticKey },
              },
            });
          }
        }
        return;
      }
      throw err;
    }
  }
}
