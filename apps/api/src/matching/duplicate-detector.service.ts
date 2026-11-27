import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export type DuplicateCheckResult =
  | { kind: 'NONE' }
  | { kind: 'SELF_RETRY_ALREADY_CONFIRMED'; originalProofId: string }
  | {
      kind: 'FRAUD_DUPLICATE';
      reason: 'DUPLICATE_REF' | 'DUPLICATE_IMAGE_EXACT' | 'DUPLICATE_IMAGE_PHASH';
      matchedProofId: string;
      hammingDistance?: number;
    };

interface PhashCandidateRow {
  id: string;
  customerId: string;
  status: string;
  createdAt: Date;
  hamming: bigint;
}

@Injectable()
export class DuplicateDetectorService {
  constructor(private readonly prisma: PrismaService) {}

  async check(proof: {
    id: string;
    sellerId: string;
    customerId: string | null;
    extractedRef: string | null;
    imageSha256: string;
    imagePhash: bigint | null;
  }): Promise<DuplicateCheckResult> {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    const otherCustomerFilter = proof.customerId
      ? { customerId: { not: proof.customerId } }
      : { customerId: { not: null } };

    // 1. Exact reference reuse (ignores prior UNREADABLE/UNMATCHED retries by the same buyer)
    if (proof.extractedRef) {
      const refMatch = await this.prisma.proof.findFirst({
        where: {
          sellerId: proof.sellerId,
          id: { not: proof.id },
          extractedRef: proof.extractedRef,
          OR: [
            { status: { in: ['CONFIRMED', 'REJECTED', 'SUSPICIOUS'] } },
            otherCustomerFilter,
          ],
        },
        select: { id: true, customerId: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });

      if (refMatch) {
        if (
          proof.customerId &&
          refMatch.customerId === proof.customerId &&
          refMatch.status === 'CONFIRMED' &&
          refMatch.createdAt >= tenMinAgo
        ) {
          return { kind: 'SELF_RETRY_ALREADY_CONFIRMED', originalProofId: refMatch.id };
        }
        return { kind: 'FRAUD_DUPLICATE', reason: 'DUPLICATE_REF', matchedProofId: refMatch.id };
      }
    }

    // 2. Exact SHA-256 byte match
    const shaMatch = await this.prisma.proof.findFirst({
      where: {
        sellerId: proof.sellerId,
        id: { not: proof.id },
        imageSha256: proof.imageSha256,
        createdAt: { gte: ninetyDaysAgo },
        OR: [
          { status: { in: ['CONFIRMED', 'REJECTED', 'SUSPICIOUS'] } },
          otherCustomerFilter,
        ],
      },
      select: { id: true, customerId: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    if (shaMatch) {
      if (
        proof.customerId &&
        shaMatch.customerId === proof.customerId &&
        shaMatch.status === 'CONFIRMED' &&
        shaMatch.createdAt >= tenMinAgo
      ) {
        return { kind: 'SELF_RETRY_ALREADY_CONFIRMED', originalProofId: shaMatch.id };
      }
      return {
        kind: 'FRAUD_DUPLICATE',
        reason: 'DUPLICATE_IMAGE_EXACT',
        matchedProofId: shaMatch.id,
      };
    }

    if (proof.imagePhash === null) {
      return { kind: 'NONE' };
    }

    // 3. Perceptual 64-bit Hamming distance <= 6 (catches re-compressed/cropped forwards)
    const phashRows = await this.prisma.$queryRaw<PhashCandidateRow[]>`
      SELECT
        "id",
        "customerId",
        "status"::text AS "status",
        "createdAt",
        bit_count(("imagePhash" # ${proof.imagePhash})::bit(64)) AS "hamming"
      FROM "Proof"
      WHERE "sellerId" = ${proof.sellerId}
        AND "id" <> ${proof.id}
        AND "imagePhash" IS NOT NULL
        AND "createdAt" >= ${ninetyDaysAgo}
        AND (
          "status" IN ('CONFIRMED', 'REJECTED', 'SUSPICIOUS')
          OR (${proof.customerId}::text IS NOT NULL AND "customerId" <> ${proof.customerId})
        )
        AND bit_count(("imagePhash" # ${proof.imagePhash})::bit(64)) <= 6
      ORDER BY "hamming" ASC, "createdAt" DESC
      LIMIT 1
    `;

    const hit = phashRows[0];
    if (!hit) return { kind: 'NONE' };

    if (
      proof.customerId &&
      hit.customerId === proof.customerId &&
      hit.status === 'CONFIRMED' &&
      hit.createdAt >= tenMinAgo
    ) {
      return { kind: 'SELF_RETRY_ALREADY_CONFIRMED', originalProofId: hit.id };
    }

    return {
      kind: 'FRAUD_DUPLICATE',
      reason: 'DUPLICATE_IMAGE_PHASH',
      matchedProofId: hit.id,
      hammingDistance: Number(hit.hamming),
    };
  }
}