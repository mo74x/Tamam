import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DecisionActor, Prisma, ProofStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const FEE_TOLERANCE_PIASTERS = 1500n;
const OVERRIDEABLE_STATUSES = new Set<ProofStatus>([
  ProofStatus.WAITING,
  ProofStatus.SUSPICIOUS,
  ProofStatus.UNMATCHED,
]);

function isPgLockTimeoutError(err: unknown): boolean {
  const anyErr = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    anyErr?.code === '55P03' ||
    anyErr?.meta?.code === '55P03' ||
    (typeof anyErr?.message === 'string' && anyErr.message.includes('55P03'))
  );
}

@Injectable()
export class ManualOverrideService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('replies') private readonly repliesQueue: Queue,
    @InjectQueue('matching') private readonly matchingQueue: Queue,
  ) {}

  async confirmProof(params: {
    sellerId: string;
    proofId: string;
    actorRole: DecisionActor;
    actorId: string;
    evidenceId?: string;
    autoLinkSingleCandidate?: boolean;
    note?: string;
  }) {
    let proofRecipient: string | null = null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2000ms'`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${params.sellerId}, 0))`;

        const proof = await tx.proof.findFirst({
          where: { id: params.proofId, sellerId: params.sellerId },
          include: {
            customer: { select: { phone: true } },
            seller: { select: { matchWindowBeforeMs: true, matchWindowAfterMs: true } },
          },
        });
        if (!proof) throw new NotFoundException('Proof not found');
        if (!OVERRIDEABLE_STATUSES.has(proof.status)) {
          throw new ConflictException(`Proof cannot be confirmed from status ${proof.status}`);
        }

        proofRecipient = proof.replyToPhone ?? proof.customer?.phone ?? null;

        let chosenEvidenceId = params.evidenceId;
        let statusReason = 'MANUAL_OVERRIDE';

        if (!chosenEvidenceId && params.autoLinkSingleCandidate) {
          if (proof.extractedAmountPiasters === null) {
            throw new ConflictException('Proof has no readable amount; resolve from dashboard');
          }
          const anchor = proof.extractedTime ?? proof.createdAt;
          const windowStart = new Date(anchor.getTime() - proof.seller.matchWindowBeforeMs);
          const windowEnd = new Date(anchor.getTime() + proof.seller.matchWindowAfterMs);
          const minAmount =
            proof.extractedAmountPiasters > FEE_TOLERANCE_PIASTERS
              ? proof.extractedAmountPiasters - FEE_TOLERANCE_PIASTERS
              : 1n;
          const maxAmount = proof.extractedAmountPiasters + FEE_TOLERANCE_PIASTERS;

          const candidates = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "Evidence"
            WHERE "sellerId" = ${params.sellerId}
              AND "claimedByProofId" IS NULL
              AND "parsedAmountPiasters" BETWEEN ${minAmount} AND ${maxAmount}
              AND COALESCE("parsedTime", "receivedAt") BETWEEN ${windowStart} AND ${windowEnd}
            ORDER BY "receivedAt" ASC
            LIMIT 2
          `;

          if (candidates.length === 1) {
            chosenEvidenceId = candidates[0].id;
          } else if (candidates.length > 1) {
            throw new ConflictException(
              'Multiple candidate deposits found; resolve from dashboard',
            );
          } else {
            throw new ConflictException(
              'No matching unclaimed deposit in window; confirm uncorroborated from dashboard',
            );
          }
        }

        if (chosenEvidenceId) {
          const ev = await tx.evidence.findFirst({
            where: { id: chosenEvidenceId, sellerId: params.sellerId, claimedByProofId: null },
          });
          if (!ev) throw new ConflictException('Evidence already claimed or not found');

          await tx.evidence.update({
            where: { id: ev.id },
            data: { claimedByProofId: proof.id },
          });
          await tx.match.create({
            data: {
              proofId: proof.id,
              evidenceId: ev.id,
              score: 100,
              reasons: ['MANUAL_OVERRIDE'],
              decidedBy: params.actorRole,
              actorId: params.actorId,
              note: params.note,
            },
          });
        } else {
          statusReason = 'MANUAL_OVERRIDE_UNCORROBORATED';
        }

        await tx.proof.update({
          where: { id: proof.id },
          data: { status: ProofStatus.CONFIRMED, statusReason },
        });

        await tx.auditLog.create({
          data: {
            sellerId: params.sellerId,
            entityType: 'PROOF',
            entityId: proof.id,
            action: 'MANUAL_OVERRIDE_CONFIRM',
            actorType: params.actorRole,
            actorId: params.actorId,
            payload: {
              evidenceId: chosenEvidenceId ?? null,
              uncorroborated: !chosenEvidenceId,
              note: params.note ?? null,
            },
          },
        });
      });
    } catch (err) {
      if (isPgLockTimeoutError(err)) {
        throw new ConflictException('Matching busy, retry momentarily');
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Evidence was claimed concurrently');
      }
      throw err;
    }

    await this.repliesQueue.remove(`waiting-reply:${params.proofId}`);
    await this.matchingQueue.remove(`expire-proof:${params.proofId}`);

    if (proofRecipient) {
      await this.repliesQueue.add('customer-confirmed', {
        sellerId: params.sellerId,
        customerPhone: proofRecipient,
        proofId: params.proofId,
      });
    }

    return { ok: true, status: ProofStatus.CONFIRMED };
  }

  async rejectProof(params: {
    sellerId: string;
    proofId: string;
    actorRole: DecisionActor;
    actorId: string;
    isFraud?: boolean;
    note?: string;
  }) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2000ms'`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${params.sellerId}, 0))`;

        const proof = await tx.proof.findFirst({
          where: { id: params.proofId, sellerId: params.sellerId },
        });
        if (!proof) throw new NotFoundException('Proof not found');
        if (!OVERRIDEABLE_STATUSES.has(proof.status)) {
          throw new ConflictException(`Proof cannot be rejected from status ${proof.status}`);
        }

        const effectiveFraud = params.isFraud ?? proof.status === ProofStatus.SUSPICIOUS;

        await tx.proof.update({
          where: { id: proof.id },
          data: {
            status: ProofStatus.REJECTED,
            statusReason: effectiveFraud ? 'MANUAL_REJECT_FRAUD' : 'MANUAL_REJECT',
          },
        });

        if (effectiveFraud && proof.customerId) {
          await tx.$executeRaw`
            UPDATE "Customer"
            SET "trustScore" = GREATEST(0, "trustScore" - 35)
            WHERE "id" = ${proof.customerId}
          `;
        }

        await tx.auditLog.create({
          data: {
            sellerId: params.sellerId,
            entityType: 'PROOF',
            entityId: proof.id,
            action: 'MANUAL_OVERRIDE_REJECT',
            actorType: params.actorRole,
            actorId: params.actorId,
            payload: { isFraud: effectiveFraud, note: params.note ?? null },
          },
        });
      });
    } catch (err) {
      if (isPgLockTimeoutError(err)) {
        throw new ConflictException('Matching busy, retry momentarily');
      }
      throw err;
    }

    await this.repliesQueue.remove(`waiting-reply:${params.proofId}`);
    await this.matchingQueue.remove(`expire-proof:${params.proofId}`);

    return { ok: true, status: ProofStatus.REJECTED };
  }
}
