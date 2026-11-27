import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EvidenceSource, Prisma } from '../generated/prisma/client.js';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { ParserRegistryService } from './parsers/parser-registry.service.js';

interface EvidenceJobData {
  sellerId: string;
  source: EvidenceSource;
  senderApp: string | null;
  rawText: string;
  receivedAt: string;
  dedupeHash: string;
}

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
    const { sellerId, source, senderApp, rawText, dedupeHash } = job.data;
    const receivedAt = new Date(job.data.receivedAt);

    const parsed = await this.parserRegistry.parse(senderApp, rawText, receivedAt);
    if (!parsed) {
      this.logger.warn(`Unparsed evidence for seller=${sellerId} app=${senderApp}`);
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

    try {
      const evidence = await this.prisma.evidence.create({
        data: {
          sellerId,
          source,
          senderApp,
          dedupeHash,
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

      // Trigger serialized matching engine (built in Slice 4)
      await this.matchingQueue.add(
        'match-evidence',
        { sellerId, evidenceId: evidence.id },
        { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
      );
    } catch (err) {
      // Idempotent guard if job ran twice after queue eviction
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return;
      }
      throw err;
    }
  }
}