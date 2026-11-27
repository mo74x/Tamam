import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DecisionActor, Prisma, ProofStatus } from '../generated/prisma/client.js';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';

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
    note?: string;
  }) {
    const proof = await this.prisma.proof.findFirst({
      where: { id: params.proofId, sellerId: params.sellerId },
      include: { customer: { select: { phone: true } } },
    });
    if (!proof) throw new NotFoundException('Proof not found');

    try {
      await this.prisma.$transaction(async (tx) => {
        if (params.evidenceId) {
          const ev = await tx.evidence.findFirst({
            where: { id: params.evidenceId, sellerId: params.sellerId, claimedByProofId: null },
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
        }

        await tx.proof.update({
          where: { id: proof.id },
          data: { status: ProofStatus.CONFIRMED, statusReason: 'MANUAL_OVERRIDE' },
        });

        await tx.auditLog.create({
          data: {
            sellerId: params.sellerId,
            entityType: 'PROOF',
            entityId: proof.id,
            action: 'MANUAL_OVERRIDE_CONFIRM',
            actorType: params.actorRole,
            actorId: params.actorId,
            payload: { evidenceId: params.evidenceId ?? null, note: params.note ?? null },
          },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Evidence was claimed concurrently');
      }
      throw err;
    }

    await this.repliesQueue.remove(`waiting-reply:${proof.id}`);
    await this.matchingQueue.remove(`expire-proof:${proof.id}`);

    const recipientPhone = proof.replyToPhone ?? proof.customer?.phone;
    if (recipientPhone) {
      await this.repliesQueue.add('customer-confirmed', {
        sellerId: params.sellerId,
        customerPhone: recipientPhone,
        proofId: proof.id,
      });
    }

    return { ok: true, status: ProofStatus.CONFIRMED };
  }

  async rejectProof(params: {
    sellerId: string;
    proofId: string;
    actorRole: DecisionActor;
    actorId: string;
    isFraud: boolean;
    note?: string;
  }) {
    const proof = await this.prisma.proof.findFirst({
      where: { id: params.proofId, sellerId: params.sellerId },
    });
    if (!proof) throw new NotFoundException('Proof not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.proof.update({
        where: { id: proof.id },
        data: {
          status: ProofStatus.REJECTED,
          statusReason: params.isFraud ? 'MANUAL_REJECT_FRAUD' : 'MANUAL_REJECT',
        },
      });

      if (params.isFraud && proof.customerId) {
        await tx.customer.update({
          where: { id: proof.customerId },
          data: { trustScore: { decrement: 35 } },
        });
      }

      await tx.auditLog.create({
        data: {
          sellerId: params.sellerId,
          entityType: 'PROOF',
          entityId: proof.id,
          action: 'MANUAL_OVERRIDE_REJECT',
          actorType: params.actorRole,
          actorId: params.actorId,
          payload: { isFraud: params.isFraud, note: params.note ?? null },
        },
      });
    });

    await this.repliesQueue.remove(`waiting-reply:${proof.id}`);
    await this.matchingQueue.remove(`expire-proof:${proof.id}`);

    // Never auto-accuse the customer; seller handles rejected chats directly
    return { ok: true, status: ProofStatus.REJECTED };
  }
}