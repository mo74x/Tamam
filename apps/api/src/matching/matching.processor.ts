import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, Job, Queue, UnrecoverableError } from 'bullmq';
import { DecisionActor, Prisma, ProofStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DuplicateDetectorService } from './duplicate-detector.service.js';
import { ManualOverrideService } from './manual-override.service.js';
import { EvidenceCandidate, scoreAndDecide } from './scoring.js';

type MatchingJobData =
  | { sellerId: string; proofId: string }
  | { sellerId: string; evidenceId: string }
  | { proofId: string; verb: 'CONFIRM' | 'REJECT'; senderPhone: string };

interface LockedEvidenceRow {
  id: string;
  parsedAmountPiasters: bigint;
  parsedRef: string | null;
  parsedTime: Date | null;
  parsedSender: string | null;
  parseConfidence: number;
  receivedAt: Date;
}

const FEE_TOLERANCE_PIASTERS = 1500n;

@Processor('matching', { concurrency: 10 })
export class MatchingProcessor extends WorkerHost {
  private readonly logger = new Logger(MatchingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly duplicates: DuplicateDetectorService,
    private readonly manualOverride: ManualOverrideService,
    @InjectQueue('matching') private readonly matchingQueue: Queue,
    @InjectQueue('replies') private readonly repliesQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<MatchingJobData>, token?: string): Promise<void> {
    if (job.name === 'owner-action') {
      await this.handleOwnerAction(
        job.data as { proofId: string; verb: 'CONFIRM' | 'REJECT'; senderPhone: string },
      );
      return;
    }

    if (job.name === 'expire-waiting-proof') {
      await this.expireWaitingProof((job.data as { sellerId: string; proofId: string }).proofId);
      return;
    }

    if (job.name === 'match-evidence') {
      const data = job.data as { sellerId: string; evidenceId: string };
      await this.matchWaitingProofsForEvidence(data.sellerId, data.evidenceId, job, token);
      return;
    }

    if (job.name === 'match-proof') {
      const data = job.data as { sellerId: string; proofId: string };
      const res = await this.matchProof(data.sellerId, data.proofId);
      if (res === 'LOCK_CONTENDED') {
        const jitterMs = 200 + Math.floor(Math.random() * 250);
        await job.moveToDelayed(Date.now() + jitterMs, token);
        throw new DelayedError();
      }
    }
  }

  private async handleOwnerAction(data: {
    proofId: string;
    verb: 'CONFIRM' | 'REJECT';
    senderPhone: string;
  }): Promise<void> {
    const proof = await this.prisma.proof.findUnique({
      where: { id: data.proofId },
      include: {
        seller: {
          select: {
            id: true,
            ownerPhone: true,
            members: {
              where: { phone: data.senderPhone, isActive: true },
              select: { id: true, role: true },
            },
          },
        },
      },
    });
    if (!proof) return;

    const isOwner = proof.seller.ownerPhone === data.senderPhone;
    const member = proof.seller.members[0];
    if (!isOwner && !member) {
      this.logger.warn(
        `Unauthorized WhatsApp owner-action from ${data.senderPhone} on proof=${data.proofId}`,
      );
      return;
    }

    const actorRole = isOwner ? DecisionActor.OWNER : (member.role as DecisionActor);
    const actorId = member?.id ?? proof.seller.id;

    try {
      if (data.verb.toUpperCase() === 'CONFIRM') {
        await this.manualOverride.confirmProof({
          sellerId: proof.sellerId,
          proofId: proof.id,
          actorRole,
          actorId,
          autoLinkSingleCandidate: true,
          note: 'Confirmed via WhatsApp alert button',
        });
        await this.repliesQueue.add('owner-action-feedback', {
          sellerId: proof.sellerId,
          recipientPhone: data.senderPhone,
          proofId: proof.id,
          message: 'تم تأكيد الإيصال ✅',
        });
      } else {
        await this.manualOverride.rejectProof({
          sellerId: proof.sellerId,
          proofId: proof.id,
          actorRole,
          actorId,
          isFraud: proof.status === ProofStatus.SUSPICIOUS,
          note: 'Rejected via WhatsApp alert button',
        });
        await this.repliesQueue.add('owner-action-feedback', {
          sellerId: proof.sellerId,
          recipientPhone: data.senderPhone,
          proofId: proof.id,
          message: 'تم رفض الإيصال ❌',
        });
      }
    } catch (err) {
      const msg = (err as Error).message || 'تعذر تنفيذ الإجراء';
      await this.repliesQueue.add('owner-action-feedback', {
        sellerId: proof.sellerId,
        recipientPhone: data.senderPhone,
        proofId: proof.id,
        message: msg,
      });
      throw new UnrecoverableError(msg);
    }
  }

  private async matchProof(
    sellerId: string,
    proofId: string,
    opts?: { unmatchedLagBypass?: boolean },
  ): Promise<'LOCK_CONTENDED' | 'CONFIRMED' | 'DONE'> {
    type TxOutcome =
      | { outcome: 'LOCK_CONTENDED' }
      | { outcome: 'NOOP' }
      | {
          outcome: 'SELF_RETRY';
          originalProofId: string;
          alreadyConfirmed: boolean;
          sellerId: string;
          proofId: string;
          recipientPhone: string | null;
        }
      | {
          outcome: 'CONFIRMED';
          sellerId: string;
          proofId: string;
          recipientPhone: string | null;
        }
      | {
          outcome: 'SUSPICIOUS';
          sellerId: string;
          proofId: string;
          ownerPhone: string;
          recipientPhone: string | null;
          reasonCode: string;
        }
      | {
          outcome: 'WAITING';
          sellerId: string;
          proofId: string;
          recipientPhone: string | null;
          waitingDebounceMs: number;
          expiresAt: Date;
          wasProcessing: boolean;
        };

    const txResult: TxOutcome = await this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${sellerId}, 0)) AS locked
        `;
        if (!locked) {
          return { outcome: 'LOCK_CONTENDED' };
        }

        const proof = await tx.proof.findUnique({
          where: { id: proofId },
          include: {
            seller: {
              select: {
                id: true,
                ownerPhone: true,
                matchWindowBeforeMs: true,
                matchWindowAfterMs: true,
                waitingDebounceMs: true,
                retentionDays: true,
              },
            },
            customer: { select: { id: true, phone: true } },
          },
        });

        const validStatuses: ProofStatus[] = opts?.unmatchedLagBypass
          ? [ProofStatus.UNMATCHED]
          : [ProofStatus.PROCESSING, ProofStatus.WAITING];

        if (!proof || !proof.extractedAmountPiasters || !validStatuses.includes(proof.status)) {
          return { outcome: 'NOOP' };
        }

        const recipientPhone = proof.replyToPhone ?? proof.customer?.phone ?? null;

        // 1. Duplicate check on fresh PROCESSING proofs
        if (proof.status === ProofStatus.PROCESSING) {
          const dup = await this.duplicates.check(
            tx,
            {
              id: proof.id,
              sellerId: proof.sellerId,
              customerId: proof.customerId,
              isForwarded: proof.isForwarded,
              extractedRef: proof.extractedRef,
              imageSha256: proof.imageSha256,
              imagePhash: proof.imagePhash,
            },
            proof.seller.retentionDays,
          );

          if (
            dup.kind === 'SELF_RETRY_ALREADY_CONFIRMED' ||
            dup.kind === 'SELF_RETRY_WAITING'
          ) {
            await tx.proof.update({
              where: { id: proof.id },
              data: {
                status: ProofStatus.SUPERSEDED,
                statusReason: dup.kind,
              },
            });
            await tx.auditLog.create({
              data: {
                sellerId: proof.sellerId,
                entityType: 'PROOF',
                entityId: proof.id,
                action: 'PROOF_SELF_RETRY_SUPERSEDED',
                actorType: 'SYSTEM',
                payload: { originalProofId: dup.originalProofId, kind: dup.kind },
              },
            });
            return {
              outcome: 'SELF_RETRY',
              originalProofId: dup.originalProofId,
              alreadyConfirmed: dup.kind === 'SELF_RETRY_ALREADY_CONFIRMED',
              sellerId: proof.sellerId,
              proofId: proof.id,
              recipientPhone,
            };
          }

          if (dup.kind === 'FRAUD_DUPLICATE') {
            await tx.proof.update({
              where: { id: proof.id },
              data: { status: ProofStatus.SUSPICIOUS, statusReason: dup.reason },
            });
            await tx.auditLog.create({
              data: {
                sellerId: proof.sellerId,
                entityType: 'PROOF',
                entityId: proof.id,
                action: 'PROOF_FLAGGED_DUPLICATE',
                actorType: 'SYSTEM',
                payload: {
                  reasonCode: dup.reason,
                  matchedProofId: dup.matchedProofId,
                  hammingDistance: dup.hammingDistance ?? null,
                },
              },
            });
            return {
              outcome: 'SUSPICIOUS',
              sellerId: proof.sellerId,
              proofId: proof.id,
              ownerPhone: proof.seller.ownerPhone,
              recipientPhone,
              reasonCode: dup.reason,
            };
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

        const [{ count: competingCountBigInt }] = await tx.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(*)::bigint AS count
          FROM "Proof"
          WHERE "sellerId" = ${proof.sellerId}
            AND "id" <> ${proof.id}
            AND "status" IN ('PROCESSING', 'WAITING')
            AND "extractedAmountPiasters" BETWEEN ${minAmount} AND ${maxAmount}
            AND COALESCE("extractedTime", "createdAt") BETWEEN ${windowStart} AND ${windowEnd}
        `;
        const competingOpenProofsCount = Number(competingCountBigInt);

        const refBypassClause = proof.extractedRef
          ? Prisma.sql`OR ("parsedRef" IS NOT NULL AND ("parsedRef" = ${proof.extractedRef} OR RIGHT("parsedRef", 8) = RIGHT(${proof.extractedRef}, 8)))`
          : Prisma.empty;

        const timeClause =
          opts?.unmatchedLagBypass && proof.extractedRef
            ? Prisma.sql`(
                COALESCE("parsedTime", "receivedAt") BETWEEN ${windowStart} AND ${windowEnd}
                ${refBypassClause}
              )`
            : Prisma.sql`(
                COALESCE("parsedTime", "receivedAt") BETWEEN ${windowStart} AND ${windowEnd}
                ${refBypassClause}
              )`;

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
            AND ${timeClause}
          ORDER BY "receivedAt" ASC
          FOR UPDATE SKIP LOCKED
        `;

        const candidates: EvidenceCandidate[] = rows.map((r) => ({
          ...r,
          parsedAmountPiasters: BigInt(r.parsedAmountPiasters),
        }));

        const decision = scoreAndDecide(
          {
            id: proof.id,
            extractedAmountPiasters: proof.extractedAmountPiasters,
            extractedRef: proof.extractedRef,
            extractedTime: proof.extractedTime,
            extractedSender: proof.extractedSender,
            createdAt: proof.createdAt,
            visualAnomalies: rawMeta.fields?.visualAnomalies ?? [],
            editingSoftwareFlag: rawMeta.forensics?.editingSoftwareFlag ?? null,
            competingOpenProofsCount,
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

          return {
            outcome: 'CONFIRMED',
            sellerId: proof.sellerId,
            proofId: proof.id,
            recipientPhone,
          };
        }

        // For 24h UNMATCHED evidence arrivals, never revert non-confirmed proofs
        if (opts?.unmatchedLagBypass) {
          return { outcome: 'NOOP' };
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
            outcome: 'SUSPICIOUS',
            sellerId: proof.sellerId,
            proofId: proof.id,
            ownerPhone: proof.seller.ownerPhone,
            recipientPhone,
            reasonCode: decision.reasonCode,
          };
        }

        const expiresAt = proof.expiresAt ?? new Date(Date.now() + proof.seller.matchWindowAfterMs);
        if (proof.status === ProofStatus.PROCESSING) {
          await tx.proof.update({
            where: { id: proof.id },
            data: { status: ProofStatus.WAITING, expiresAt },
          });
        }

        return {
          outcome: 'WAITING',
          sellerId: proof.sellerId,
          proofId: proof.id,
          recipientPhone,
          waitingDebounceMs: proof.seller.waitingDebounceMs,
          expiresAt,
          wasProcessing: proof.status === ProofStatus.PROCESSING,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 3000, timeout: 10000 },
    );

    if (txResult.outcome === 'LOCK_CONTENDED') {
      return 'LOCK_CONTENDED';
    }
    if (txResult.outcome === 'NOOP') {
      return 'DONE';
    }

    if (txResult.outcome === 'SELF_RETRY') {
      if (txResult.alreadyConfirmed && txResult.recipientPhone) {
        await this.repliesQueue.add('customer-confirmed', {
          sellerId: txResult.sellerId,
          customerPhone: txResult.recipientPhone,
          proofId: txResult.proofId,
        });
      }
      return 'DONE';
    }

    if (txResult.outcome === 'CONFIRMED') {
      await this.repliesQueue.remove(`waiting-reply:${txResult.proofId}`);
      await this.matchingQueue.remove(`expire-proof:${txResult.proofId}`);

      if (txResult.recipientPhone) {
        await this.repliesQueue.add('customer-confirmed', {
          sellerId: txResult.sellerId,
          customerPhone: txResult.recipientPhone,
          proofId: txResult.proofId,
        });
      }
      return 'CONFIRMED';
    }

    if (txResult.outcome === 'SUSPICIOUS') {
      await this.repliesQueue.remove(`waiting-reply:${txResult.proofId}`);
      await this.matchingQueue.remove(`expire-proof:${txResult.proofId}`);

      if (txResult.recipientPhone) {
        await this.repliesQueue.add('customer-suspicious', {
          sellerId: txResult.sellerId,
          customerPhone: txResult.recipientPhone,
          proofId: txResult.proofId,
        });
      }
      await this.repliesQueue.add('owner-alert', {
        sellerId: txResult.sellerId,
        ownerPhone: txResult.ownerPhone,
        proofId: txResult.proofId,
        status: 'SUSPICIOUS',
        reasonCode: txResult.reasonCode,
      });
      return 'DONE';
    }

    if (txResult.wasProcessing) {
      if (txResult.recipientPhone) {
        await this.repliesQueue.add(
          'customer-waiting',
          {
            sellerId: txResult.sellerId,
            customerPhone: txResult.recipientPhone,
            proofId: txResult.proofId,
          },
          {
            jobId: `waiting-reply:${txResult.proofId}`,
            delay: txResult.waitingDebounceMs,
          },
        );
      }

      const ttlMs = Math.max(1000, txResult.expiresAt.getTime() - Date.now());
      await this.matchingQueue.add(
        'expire-waiting-proof',
        { sellerId: txResult.sellerId, proofId: txResult.proofId },
        { jobId: `expire-proof:${txResult.proofId}`, delay: ttlMs },
      );
    }

    return 'DONE';
  }

  private async matchWaitingProofsForEvidence(
    sellerId: string,
    evidenceId: string,
    job: Job<MatchingJobData>,
    token?: string,
  ): Promise<void> {
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

    const waitingProofs = await this.prisma.proof.findMany({
      where: {
        sellerId,
        status: ProofStatus.WAITING,
        extractedAmountPiasters: { gte: minAmount, lte: maxAmount },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    for (const wp of waitingProofs) {
      const res = await this.matchProof(sellerId, wp.id);
      if (res === 'LOCK_CONTENDED') {
        const jitterMs = 200 + Math.floor(Math.random() * 250);
        await job.moveToDelayed(Date.now() + jitterMs, token);
        throw new DelayedError();
      }
      const refreshed = await this.prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { claimedByProofId: true },
      });
      if (refreshed?.claimedByProofId) return;
    }

    // Second pass: late-arriving evidence vs 24h UNMATCHED proofs (Tier 1 / clean CONFIRMED only)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600_000);
    const unmatchedProofs = await this.prisma.proof.findMany({
      where: {
        sellerId,
        status: ProofStatus.UNMATCHED,
        statusReason: 'EVIDENCE_TIMEOUT',
        extractedAmountPiasters: evidence.parsedAmountPiasters,
        createdAt: { gte: twentyFourHoursAgo },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    for (const up of unmatchedProofs) {
      const res = await this.matchProof(sellerId, up.id, { unmatchedLagBypass: true });
      if (res === 'LOCK_CONTENDED') {
        const jitterMs = 200 + Math.floor(Math.random() * 250);
        await job.moveToDelayed(Date.now() + jitterMs, token);
        throw new DelayedError();
      }
      const refreshed = await this.prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { claimedByProofId: true },
      });
      if (refreshed?.claimedByProofId) return;
    }
  }

  private async expireWaitingProof(proofId: string): Promise<void> {
    const expired = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.proof.updateMany({
        where: { id: proofId, status: ProofStatus.WAITING },
        data: { status: ProofStatus.UNMATCHED, statusReason: 'EVIDENCE_TIMEOUT' },
      });
      if (updated.count === 0) return null;

      const proof = await tx.proof.findUnique({
        where: { id: proofId },
        include: {
          seller: { select: { ownerPhone: true } },
          customer: { select: { phone: true } },
        },
      });
      if (!proof) return null;

      await tx.auditLog.create({
        data: {
          sellerId: proof.sellerId,
          entityType: 'PROOF',
          entityId: proof.id,
          action: 'PROOF_EXPIRED_UNMATCHED',
          actorType: 'SYSTEM',
          payload: { expiresAt: proof.expiresAt?.toISOString() },
        },
      });
      return proof;
    });

    if (!expired) return;

    const recipientPhone = expired.replyToPhone ?? expired.customer?.phone;
    if (recipientPhone) {
      await this.repliesQueue.add('customer-waiting-longer', {
        sellerId: expired.sellerId,
        customerPhone: recipientPhone,
        proofId: expired.id,
      });
    }
    await this.repliesQueue.add('owner-alert', {
      sellerId: expired.sellerId,
      ownerPhone: expired.seller.ownerPhone,
      proofId: expired.id,
      status: 'UNMATCHED',
      reasonCode: 'EVIDENCE_TIMEOUT',
    });
  }
}
