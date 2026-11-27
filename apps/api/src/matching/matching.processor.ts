import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DecisionActor, Prisma, ProofStatus } from '../generated/prisma/client.js';
import { DelayedError, Job, Queue } from 'bullmq';
import { RedisLockService } from '../common/redis-lock.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DuplicateDetectorService } from './duplicate-detector.service.js';
import { EvidenceCandidate, scoreAndDecide } from './scoring.js';

type MatchingJobData =
  | { sellerId: string; proofId: string }
  | { sellerId: string; evidenceId: string };

interface LockedEvidenceRow {
  id: string;
  parsedAmountPiasters: bigint;
  parsedRef: string | null;
  parsedTime: Date | null;
  parsedSender: string | null;
  parseConfidence: number;
  receivedAt: Date;
}

const FEE_TOLERANCE_PIASTERS = 1500n; // 15.00 EGP window to catch wallet fee deductions as Tier 3

@Processor('matching', { concurrency: 10 })
export class MatchingProcessor extends WorkerHost {
  private readonly logger = new Logger(MatchingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    private readonly duplicates: DuplicateDetectorService,
    @InjectQueue('matching') private readonly matchingQueue: Queue,
    @InjectQueue('replies') private readonly repliesQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<MatchingJobData>, token?: string): Promise<void> {
    const lockKey = `lock:match:${job.data.sellerId}`;
    const lockToken = await this.redisLock.acquire(lockKey, 15_000);

    if (!lockToken) {
      // Another job is currently matching for this seller; delay briefly with jitter
      const jitterMs = 200 + Math.floor(Math.random() * 250);
      await job.moveToDelayed(Date.now() + jitterMs, token);
      throw new DelayedError();
    }

    try {
      switch (job.name) {
        case 'match-proof':
          await this.matchProof((job.data as { sellerId: string; proofId: string }).proofId);
          break;
        case 'match-evidence':
          await this.matchWaitingProofsForEvidence(
            job.data.sellerId,
            (job.data as { evidenceId: string }).evidenceId,
          );
          break;
        case 'expire-waiting-proof':
          await this.expireWaitingProof(
            (job.data as { sellerId: string; proofId: string }).proofId,
          );
          break;
      }
    } finally {
      await this.redisLock.release(lockKey, lockToken);
    }
  }

  private async matchProof(proofId: string): Promise<void> {
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      include: {
        seller: {
          select: {
            id: true,
            ownerPhone: true,
            matchWindowBeforeMs: true,
            matchWindowAfterMs: true,
            waitingDebounceMs: true,
          },
        },
        customer: { select: { id: true, phone: true } },
      },
    });

    if (
      !proof ||
      !proof.extractedAmountPiasters ||
      !['PROCESSING', 'WAITING'].includes(proof.status)
    ) {
      return;
    }

    // 1. Run duplicate check only on fresh PROCESSING proofs
    if (proof.status === 'PROCESSING') {
      const dup = await this.duplicates.check({
        id: proof.id,
        sellerId: proof.sellerId,
        customerId: proof.customerId,
        extractedRef: proof.extractedRef,
        imageSha256: proof.imageSha256,
        imagePhash: proof.imagePhash,
      });

      if (dup.kind === 'SELF_RETRY_ALREADY_CONFIRMED') {
        await this.prisma.$transaction([
          this.prisma.proof.update({
            where: { id: proof.id },
            data: { status: ProofStatus.CONFIRMED, statusReason: 'IDEMPOTENT_SELF_RETRY' },
          }),
          this.prisma.auditLog.create({
            data: {
              sellerId: proof.sellerId,
              entityType: 'PROOF',
              entityId: proof.id,
              action: 'PROOF_SELF_RETRY_CONFIRMED',
              actorType: 'SYSTEM',
              payload: { originalProofId: dup.originalProofId },
            },
          }),
        ]);
        const recipientPhone = proof.replyToPhone ?? proof.customer?.phone;
        if (recipientPhone) {
          await this.repliesQueue.add('customer-confirmed', {
            sellerId: proof.sellerId,
            customerPhone: recipientPhone,
            proofId: proof.id,
          });
        }
        return;
      }

      if (dup.kind === 'FRAUD_DUPLICATE') {
        await this.markSuspicious(proof, dup.reason, {
          matchedProofId: dup.matchedProofId,
          hammingDistance: dup.hammingDistance ?? null,
        });
        return;
      }
    }

    const rawMeta = (proof.extractionRaw ?? {}) as {
      fields?: { visualAnomalies?: string[] };
      forensics?: { editingSoftwareFlag?: string | null };
    };

    const anchorTime = proof.extractedTime ?? proof.createdAt;
    const windowStart = new Date(anchorTime.getTime() - proof.seller.matchWindowBeforeMs);
    const windowEnd = new Date(anchorTime.getTime() + proof.seller.matchWindowAfterMs);
    const minAmount =
      proof.extractedAmountPiasters > FEE_TOLERANCE_PIASTERS
        ? proof.extractedAmountPiasters - FEE_TOLERANCE_PIASTERS
        : 1n;
    const maxAmount = proof.extractedAmountPiasters + FEE_TOLERANCE_PIASTERS;

    // 2. Atomic PostgreSQL transaction with row locks on candidate evidence
    const txResult = await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<LockedEvidenceRow[]>`
          SELECT
            "id",
            "parsedAmountPiasters",
            "parsedRef",
            "parsedTime",
            "parsedSender",
            "parseConfidence",
            "receivedAt"
          FROM "Evidence"
          WHERE "sellerId" = ${proof.sellerId}
            AND "claimedByProofId" IS NULL
            AND "parsedAmountPiasters" BETWEEN ${minAmount} AND ${maxAmount}
            AND "receivedAt" BETWEEN ${windowStart} AND ${windowEnd}
          ORDER BY "receivedAt" ASC
          FOR UPDATE SKIP LOCKED
        `;

        const candidates: EvidenceCandidate[] = rows.map((r) => ({
          ...r,
          parsedAmountPiasters: BigInt(r.parsedAmountPiasters),
          parsedTime: r.parsedTime ?? r.receivedAt,
        }));

        const decision = scoreAndDecide(
          {
            id: proof.id,
            extractedAmountPiasters: proof.extractedAmountPiasters!,
            extractedRef: proof.extractedRef,
            extractedTime: proof.extractedTime,
            extractedSender: proof.extractedSender,
            createdAt: proof.createdAt,
            visualAnomalies: rawMeta.fields?.visualAnomalies ?? [],
            editingSoftwareFlag: rawMeta.forensics?.editingSoftwareFlag ?? null,
          },
          candidates,
        );

        if (decision.outcome === 'CONFIRMED') {
          await tx.evidence.update({
            where: { id: decision.winner.evidenceId },
            data: { claimedByProofId: proof.id },
          });

          await tx.proof.update({
            where: { id: proof.id },
            data: { status: ProofStatus.CONFIRMED, statusReason: decision.reasons[0] },
          });

          await tx.match.create({
            data: {
              proofId: proof.id,
              evidenceId: decision.winner.evidenceId,
              score: decision.winner.score,
              reasons: decision.reasons,
              decidedBy: DecisionActor.SYSTEM,
            },
          });

          await tx.auditLog.create({
            data: {
              sellerId: proof.sellerId,
              entityType: 'PROOF',
              entityId: proof.id,
              action: 'PROOF_AUTO_CONFIRMED',
              actorType: 'SYSTEM',
              payload: {
                evidenceId: decision.winner.evidenceId,
                score: decision.winner.score,
                reasons: decision.reasons,
              },
            },
          });

          return { outcome: 'CONFIRMED' as const };
        }

        if (decision.outcome === 'SUSPICIOUS') {
          await tx.proof.update({
            where: { id: proof.id },
            data: { status: ProofStatus.SUSPICIOUS, statusReason: decision.reasonCode },
          });

          await tx.auditLog.create({
            data: {
              sellerId: proof.sellerId,
              entityType: 'PROOF',
              entityId: proof.id,
              action: 'PROOF_FLAGGED_SUSPICIOUS',
              actorType: 'SYSTEM',
              payload: {
                reasonCode: decision.reasonCode,
                reasons: decision.reasons,
                candidateIds: decision.candidates.map((c) => c.evidenceId),
              },
            },
          });

          return {
            outcome: 'SUSPICIOUS' as const,
            reasonCode: decision.reasonCode,
            reasons: decision.reasons,
          };
        }

        // WAITING: only set expiresAt on initial transition from PROCESSING
        const expiresAt = proof.expiresAt ?? new Date(Date.now() + proof.seller.matchWindowAfterMs);
        if (proof.status === 'PROCESSING') {
          await tx.proof.update({
            where: { id: proof.id },
            data: { status: ProofStatus.WAITING, expiresAt },
          });
        }

        return { outcome: 'WAITING' as const, expiresAt, wasProcessing: proof.status === 'PROCESSING' };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 3000, timeout: 10000 },
    );

    // 3. Post-commit side effects (never hold DB locks while calling Redis/WhatsApp)
    if (txResult.outcome === 'CONFIRMED') {
      // Cancel debounced WAITING reply if evidence arrived within the 20s window
      await this.repliesQueue.remove(`waiting-reply:${proof.id}`);
      await this.matchingQueue.remove(`expire-proof:${proof.id}`);

      const recipientPhone = proof.replyToPhone ?? proof.customer?.phone;
      if (recipientPhone) {
        await this.repliesQueue.add('customer-confirmed', {
          sellerId: proof.sellerId,
          customerPhone: recipientPhone,
          proofId: proof.id,
        });
      }
      return;
    }

    if (txResult.outcome === 'SUSPICIOUS') {
      await this.repliesQueue.remove(`waiting-reply:${proof.id}`);
      await this.matchingQueue.remove(`expire-proof:${proof.id}`);

      const recipientPhone = proof.replyToPhone ?? proof.customer?.phone;
      if (recipientPhone) {
        await this.repliesQueue.add('customer-suspicious', {
          sellerId: proof.sellerId,
          customerPhone: recipientPhone,
          proofId: proof.id,
        });
      }
      await this.repliesQueue.add('owner-alert', {
        sellerId: proof.sellerId,
        ownerPhone: proof.seller.ownerPhone,
        proofId: proof.id,
        status: 'SUSPICIOUS',
        reasonCode: txResult.reasonCode,
      });
      return;
    }

    if (txResult.wasProcessing) {
      // Debounce WAITING reply by 20s to stay inside Meta's 1,000 free monthly messages
      const recipientPhone = proof.replyToPhone ?? proof.customer?.phone;
      if (recipientPhone) {
        await this.repliesQueue.add(
          'customer-waiting',
          {
            sellerId: proof.sellerId,
            customerPhone: recipientPhone,
            proofId: proof.id,
          },
          {
            jobId: `waiting-reply:${proof.id}`,
            delay: proof.seller.waitingDebounceMs,
          },
        );
      }

      const ttlMs = Math.max(1000, txResult.expiresAt.getTime() - Date.now());
      await this.matchingQueue.add(
        'expire-waiting-proof',
        { sellerId: proof.sellerId, proofId: proof.id },
        { jobId: `expire-proof:${proof.id}`, delay: ttlMs },
      );
    }
  }

  private async matchWaitingProofsForEvidence(sellerId: string, evidenceId: string): Promise<void> {
    const evidence = await this.prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { id: true, parsedAmountPiasters: true, claimedByProofId: true },
    });
    if (!evidence || evidence.claimedByProofId || evidence.parsedAmountPiasters === null) return;

    const minAmount =
      evidence.parsedAmountPiasters > FEE_TOLERANCE_PIASTERS
        ? evidence.parsedAmountPiasters - FEE_TOLERANCE_PIASTERS
        : 1n;
    const maxAmount = evidence.parsedAmountPiasters + FEE_TOLERANCE_PIASTERS;

    // Re-evaluate oldest WAITING proofs whose amount is in range
    const waitingProofs = await this.prisma.proof.findMany({
      where: {
        sellerId,
        status: ProofStatus.WAITING,
        extractedAmountPiasters: { gte: minAmount, lte: maxAmount },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    for (const wp of waitingProofs) {
      await this.matchProof(wp.id);
    }
  }

  private async expireWaitingProof(proofId: string): Promise<void> {
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      include: {
        seller: { select: { ownerPhone: true } },
        customer: { select: { phone: true } },
      },
    });

    if (!proof || proof.status !== ProofStatus.WAITING) return;

    await this.prisma.$transaction([
      this.prisma.proof.update({
        where: { id: proof.id },
        data: { status: ProofStatus.UNMATCHED, statusReason: 'EVIDENCE_TIMEOUT' },
      }),
      this.prisma.auditLog.create({
        data: {
          sellerId: proof.sellerId,
          entityType: 'PROOF',
          entityId: proof.id,
          action: 'PROOF_EXPIRED_UNMATCHED',
          actorType: 'SYSTEM',
          payload: { expiresAt: proof.expiresAt?.toISOString() },
        },
      }),
    ]);

    const recipientPhone = proof.replyToPhone ?? proof.customer?.phone;
    if (recipientPhone) {
      await this.repliesQueue.add('customer-waiting-longer', {
        sellerId: proof.sellerId,
        customerPhone: recipientPhone,
        proofId: proof.id,
      });
    }
    await this.repliesQueue.add('owner-alert', {
      sellerId: proof.sellerId,
      ownerPhone: proof.seller.ownerPhone,
      proofId: proof.id,
      status: 'UNMATCHED',
      reasonCode: 'EVIDENCE_TIMEOUT',
    });
  }

  private async markSuspicious(
    proof: {
      id: string;
      sellerId: string;
      replyToPhone: string | null;
      seller: { ownerPhone: string };
      customer: { phone: string } | null;
    },
    reasonCode: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.proof.update({
        where: { id: proof.id },
        data: { status: ProofStatus.SUSPICIOUS, statusReason: reasonCode },
      }),
      this.prisma.auditLog.create({
        data: {
          sellerId: proof.sellerId,
          entityType: 'PROOF',
          entityId: proof.id,
          action: 'PROOF_FLAGGED_DUPLICATE',
          actorType: 'SYSTEM',
          payload: { reasonCode, ...details },
        },
      }),
    ]);

    const recipientPhone = proof.replyToPhone ?? proof.customer?.phone;
    if (recipientPhone) {
      await this.repliesQueue.add('customer-suspicious', {
        sellerId: proof.sellerId,
        customerPhone: recipientPhone,
        proofId: proof.id,
      });
    }
    await this.repliesQueue.add('owner-alert', {
      sellerId: proof.sellerId,
      ownerPhone: proof.seller.ownerPhone,
      proofId: proof.id,
      status: 'SUSPICIOUS',
      reasonCode,
    });
  }
}