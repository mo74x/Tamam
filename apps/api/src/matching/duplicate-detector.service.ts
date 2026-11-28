import { Injectable } from '@nestjs/common';
import { Prisma, ProofStatus } from '../generated/prisma/client.js';

export type DuplicateCheckResult =
  | { kind: 'NONE' }
  | { kind: 'SELF_RETRY_ALREADY_CONFIRMED'; originalProofId: string }
  | { kind: 'SELF_RETRY_WAITING'; originalProofId: string }
  | {
      kind: 'FRAUD_DUPLICATE';
      reason: 'DUPLICATE_REF' | 'DUPLICATE_IMAGE_EXACT' | 'DUPLICATE_IMAGE_PHASH';
      matchedProofId: string;
      hammingDistance?: number;
    };

interface PhashCandidateRow {
  id: string;
  customerId: string | null;
  extractedRef: string | null;
  status: string;
  createdAt: Date;
  hamming: bigint;
}

@Injectable()
export class DuplicateDetectorService {
  async check(
    tx: Prisma.TransactionClient,
    proof: {
      id: string;
      sellerId: string;
      customerId: string | null;
      isForwarded: boolean;
      extractedRef: string | null;
      imageSha256: string;
      imagePhash: bigint | null;
    },
    sellerRetentionDays: number,
  ): Promise<DuplicateCheckResult> {
    const lookbackDays = Math.max(1, sellerRetentionDays);
    const lookbackCutoff = new Date(Date.now() - lookbackDays * 86_400_000);
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);

    const otherCustomerFilter = proof.customerId
      ? [{ customerId: { not: proof.customerId } }, { customerId: null }]
      : [{ customerId: { not: null } }];

    const canSelfRetry = !proof.isForwarded && proof.customerId !== null;

    // 1. Exact reference reuse
    if (proof.extractedRef) {
      const refMatch = await tx.proof.findFirst({
        where: {
          sellerId: proof.sellerId,
          id: { not: proof.id },
          status: { not: ProofStatus.SUPERSEDED },
          extractedRef: proof.extractedRef,
          OR: [
            { status: { in: [ProofStatus.CONFIRMED, ProofStatus.REJECTED, ProofStatus.SUSPICIOUS, ProofStatus.WAITING] } },
            ...otherCustomerFilter,
          ],
        },
        select: { id: true, customerId: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });

      if (refMatch) {
        if (canSelfRetry && refMatch.customerId === proof.customerId && refMatch.createdAt >= tenMinAgo) {
          if (refMatch.status === ProofStatus.CONFIRMED) {
            return { kind: 'SELF_RETRY_ALREADY_CONFIRMED', originalProofId: refMatch.id };
          }
          if (refMatch.status === ProofStatus.WAITING) {
            return { kind: 'SELF_RETRY_WAITING', originalProofId: refMatch.id };
          }
        }
        if (
          refMatch.status === ProofStatus.WAITING &&
          refMatch.customerId === proof.customerId &&
          !proof.isForwarded
        ) {
          return { kind: 'SELF_RETRY_WAITING', originalProofId: refMatch.id };
        }
        return { kind: 'FRAUD_DUPLICATE', reason: 'DUPLICATE_REF', matchedProofId: refMatch.id };
      }
    }

    // 2. Exact SHA-256 byte match
    const shaMatch = await tx.proof.findFirst({
      where: {
        sellerId: proof.sellerId,
        id: { not: proof.id },
        status: { not: ProofStatus.SUPERSEDED },
        imageSha256: proof.imageSha256,
        createdAt: { gte: lookbackCutoff },
        OR: [
          { status: { in: [ProofStatus.CONFIRMED, ProofStatus.REJECTED, ProofStatus.SUSPICIOUS, ProofStatus.WAITING] } },
          ...otherCustomerFilter,
        ],
      },
      select: { id: true, customerId: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    if (shaMatch) {
      if (canSelfRetry && shaMatch.customerId === proof.customerId && shaMatch.createdAt >= tenMinAgo) {
        if (shaMatch.status === ProofStatus.CONFIRMED) {
          return { kind: 'SELF_RETRY_ALREADY_CONFIRMED', originalProofId: shaMatch.id };
        }
        if (shaMatch.status === ProofStatus.WAITING) {
          return { kind: 'SELF_RETRY_WAITING', originalProofId: shaMatch.id };
        }
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

    // 3. Perceptual 64-bit Hamming distance <= 6 within seller retentionDays
    const phashRows = await tx.$queryRaw<PhashCandidateRow[]>`
      SELECT
        "id",
        "customerId",
        "extractedRef",
        "status"::text AS "status",
        "createdAt",
        bit_count(("imagePhash" # ${proof.imagePhash})::bit(64)) AS "hamming"
      FROM "Proof"
      WHERE "sellerId" = ${proof.sellerId}
        AND "id" <> ${proof.id}
        AND "status" <> 'SUPERSEDED'
        AND "imagePhash" IS NOT NULL
        AND "createdAt" >= ${lookbackCutoff}
        AND (
          "status" IN ('CONFIRMED', 'REJECTED', 'SUSPICIOUS', 'WAITING')
          OR "customerId" IS DISTINCT FROM ${proof.customerId}
        )
        AND bit_count(("imagePhash" # ${proof.imagePhash})::bit(64)) <= 6
      ORDER BY "hamming" ASC, "createdAt" DESC
      LIMIT 5
    `;

    for (const hit of phashRows) {
      // Do not treat template-similar bank screenshots with distinct transaction refs as duplicates
      if (proof.extractedRef && hit.extractedRef && proof.extractedRef !== hit.extractedRef) {
        continue;
      }

      if (canSelfRetry && hit.customerId === proof.customerId && hit.createdAt >= tenMinAgo) {
        if (hit.status === ProofStatus.CONFIRMED) {
          return { kind: 'SELF_RETRY_ALREADY_CONFIRMED', originalProofId: hit.id };
        }
        if (hit.status === ProofStatus.WAITING) {
          return { kind: 'SELF_RETRY_WAITING', originalProofId: hit.id };
        }
      }

      return {
        kind: 'FRAUD_DUPLICATE',
        reason: 'DUPLICATE_IMAGE_PHASH',
        matchedProofId: hit.id,
        hammingDistance: Number(hit.hamming),
      };
    }

    return { kind: 'NONE' };
  }
}
