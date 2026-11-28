import { ConflictException, NotFoundException } from '@nestjs/common';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { DecisionActor, ProofStatus } from '../generated/prisma/client.js';
import { DuplicateDetectorService } from './duplicate-detector.service.js';
import { ManualOverrideService } from './manual-override.service.js';
import { MatchingProcessor } from './matching.processor.js';

describe('Matching Engine (Processor, DuplicateDetector, ManualOverride)', () => {
  describe('DuplicateDetectorService', () => {
    it('supersedes 10m customer retries, excludes SUPERSEDED, and skips pHash collision for distinct refs', async () => {
      const detector = new DuplicateDetectorService();
      const tx = {
        proof: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({
              id: 'orig_1',
              customerId: 'c1',
              status: ProofStatus.CONFIRMED,
              createdAt: new Date(),
            })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null),
        },
        $queryRaw: vi.fn().mockResolvedValue([
          {
            id: 'other_1',
            customerId: 'c2',
            extractedRef: 'REF_DIFFERENT',
            status: ProofStatus.CONFIRMED,
            createdAt: new Date(),
            hamming: 2n,
          },
        ]),
      };

      const retryRes = await detector.check(
        tx as never,
        {
          id: 'p_new',
          sellerId: 's1',
          customerId: 'c1',
          isForwarded: false,
          extractedRef: 'REF123',
          imageSha256: 'sha1',
          imagePhash: 10n,
        },
        14,
      );
      expect(retryRes).toEqual({
        kind: 'SELF_RETRY_ALREADY_CONFIRMED',
        originalProofId: 'orig_1',
      });

      const distinctRefPhash = await detector.check(
        tx as never,
        {
          id: 'p_new2',
          sellerId: 's1',
          customerId: 'c1',
          isForwarded: false,
          extractedRef: 'REF_MINE',
          imageSha256: 'sha2',
          imagePhash: 10n,
        },
        14,
      );
      expect(distinctRefPhash).toEqual({ kind: 'NONE' });
    });

    it('flags SHA-256 and matching/missing-ref pHash duplicates', async () => {
      const detector = new DuplicateDetectorService();
      const txSha = {
        proof: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
              id: 'orig_sha',
              customerId: 'c2',
              status: ProofStatus.CONFIRMED,
              createdAt: new Date(),
            }),
        },
        $queryRaw: vi.fn(),
      };
      expect(
        await detector.check(
          txSha as never,
          {
            id: 'p1',
            sellerId: 's1',
            customerId: null,
            isForwarded: true,
            extractedRef: 'R1',
            imageSha256: 'dup',
            imagePhash: null,
          },
          14,
        ),
      ).toEqual({
        kind: 'FRAUD_DUPLICATE',
        reason: 'DUPLICATE_IMAGE_EXACT',
        matchedProofId: 'orig_sha',
      });

      const txPhash = {
        proof: { findFirst: vi.fn().mockResolvedValue(null) },
        $queryRaw: vi.fn().mockResolvedValue([
          {
            id: 'orig_phash',
            customerId: 'c2',
            extractedRef: null,
            status: ProofStatus.WAITING,
            createdAt: new Date(),
            hamming: 3n,
          },
        ]),
      };
      expect(
        await detector.check(
          txPhash as never,
          {
            id: 'p2',
            sellerId: 's1',
            customerId: 'c1',
            isForwarded: false,
            extractedRef: null,
            imageSha256: 'unique',
            imagePhash: 42n,
          },
          14,
        ),
      ).toEqual({
        kind: 'FRAUD_DUPLICATE',
        reason: 'DUPLICATE_IMAGE_PHASH',
        matchedProofId: 'orig_phash',
        hammingDistance: 3,
      });
    });

    it('detects WAITING self-retries and DUPLICATE_REF fraud across customers', async () => {
      const detector = new DuplicateDetectorService();
      const tx = {
        proof: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({
              id: 'orig_wait',
              customerId: 'c1',
              status: ProofStatus.WAITING,
              createdAt: new Date(Date.now() - 20 * 60_000),
            })
            .mockResolvedValueOnce({
              id: 'fraud_ref',
              customerId: 'c_other',
              status: ProofStatus.CONFIRMED,
              createdAt: new Date(),
            })
            .mockResolvedValueOnce({
              id: 'sha_wait',
              customerId: 'c1',
              status: ProofStatus.WAITING,
              createdAt: new Date(),
            })
            .mockResolvedValueOnce(null),
        },
        $queryRaw: vi.fn().mockResolvedValue([
          {
            id: 'phash_wait',
            customerId: 'c1',
            extractedRef: null,
            status: ProofStatus.WAITING,
            createdAt: new Date(),
            hamming: 1n,
          },
        ]),
      };

      expect(
        await detector.check(
          tx as never,
          {
            id: 'p_w1',
            sellerId: 's1',
            customerId: 'c1',
            isForwarded: false,
            extractedRef: 'REF_W',
            imageSha256: 's1',
            imagePhash: null,
          },
          14,
        ),
      ).toEqual({ kind: 'SELF_RETRY_WAITING', originalProofId: 'orig_wait' });

      expect(
        await detector.check(
          tx as never,
          {
            id: 'p_f1',
            sellerId: 's1',
            customerId: 'c1',
            isForwarded: false,
            extractedRef: 'REF_F',
            imageSha256: 's2',
            imagePhash: null,
          },
          14,
        ),
      ).toEqual({
        kind: 'FRAUD_DUPLICATE',
        reason: 'DUPLICATE_REF',
        matchedProofId: 'fraud_ref',
      });

      expect(
        await detector.check(
          tx as never,
          {
            id: 'p_sw',
            sellerId: 's1',
            customerId: 'c1',
            isForwarded: false,
            extractedRef: null,
            imageSha256: 'sha_dup',
            imagePhash: null,
          },
          14,
        ),
      ).toEqual({ kind: 'SELF_RETRY_WAITING', originalProofId: 'sha_wait' });

      expect(
        await detector.check(
          tx as never,
          {
            id: 'p_pw',
            sellerId: 's1',
            customerId: 'c1',
            isForwarded: false,
            extractedRef: null,
            imageSha256: 'unique_sha',
            imagePhash: 5n,
          },
          14,
        ),
      ).toEqual({ kind: 'SELF_RETRY_WAITING', originalProofId: 'phash_wait' });
    });
  });

  describe('ManualOverrideService', () => {
    const makeOverrideDeps = () => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
        proof: {
          findFirst: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
        },
        evidence: {
          findFirst: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
        },
        match: { create: vi.fn().mockResolvedValue({}) },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };
      const prisma = {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
      };
      const repliesQueue = { remove: vi.fn(), add: vi.fn() };
      const matchingQueue = { remove: vi.fn() };
      const service = new ManualOverrideService(
        prisma as never,
        repliesQueue as never,
        matchingQueue as never,
      );
      return { service, tx, prisma, repliesQueue, matchingQueue };
    };

    it('maps Postgres 55P03 lock timeout to 409 Conflict', async () => {
      const { service, tx } = makeOverrideDeps();
      tx.$executeRaw.mockRejectedValueOnce({ code: '55P03' });

      await expect(
        service.confirmProof({
          sellerId: 's1',
          proofId: 'p1',
          actorRole: DecisionActor.OWNER,
          actorId: 's1',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('supports uncorroborated Dashboard confirm vs autoLinkSingleCandidate ambiguity rejection', async () => {
      const { service, tx, repliesQueue } = makeOverrideDeps();
      tx.proof.findFirst.mockResolvedValue({
        id: 'p1',
        sellerId: 's1',
        status: ProofStatus.UNMATCHED,
        extractedAmountPiasters: 65000n,
        extractedTime: new Date(),
        createdAt: new Date(),
        replyToPhone: null,
        customer: { phone: '+201012345678' },
        seller: { matchWindowBeforeMs: 900_000, matchWindowAfterMs: 1_800_000 },
      });

      const uncorroborated = await service.confirmProof({
        sellerId: 's1',
        proofId: 'p1',
        actorRole: DecisionActor.OWNER,
        actorId: 's1',
        autoLinkSingleCandidate: false,
      });
      expect(uncorroborated).toEqual({ ok: true, status: ProofStatus.CONFIRMED });
      expect(tx.proof.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { status: ProofStatus.CONFIRMED, statusReason: 'MANUAL_OVERRIDE_UNCORROBORATED' },
      });
      expect(repliesQueue.add).toHaveBeenCalledWith(
        'customer-confirmed',
        expect.objectContaining({ customerPhone: '+201012345678' }),
      );

      tx.$queryRaw.mockResolvedValueOnce([{ id: 'ev1' }, { id: 'ev2' }]);
      await expect(
        service.confirmProof({
          sellerId: 's1',
          proofId: 'p1',
          actorRole: DecisionActor.OWNER,
          actorId: 's1',
          autoLinkSingleCandidate: true,
        }),
      ).rejects.toThrow(/Multiple candidate deposits/);
    });

    it('rejects fraud proofs with GREATEST(0, trustScore - 35) only when customerId exists and throws 404 when missing', async () => {
      const { service, tx } = makeOverrideDeps();
      tx.proof.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.rejectProof({
          sellerId: 's1',
          proofId: 'missing',
          actorRole: DecisionActor.OWNER,
          actorId: 's1',
        }),
      ).rejects.toThrow(NotFoundException);

      tx.$executeRaw.mockClear();
      tx.proof.findFirst.mockResolvedValueOnce({
        id: 'p2',
        sellerId: 's1',
        status: ProofStatus.SUSPICIOUS,
        customerId: 'cust_1',
      });
      await service.rejectProof({
        sellerId: 's1',
        proofId: 'p2',
        actorRole: DecisionActor.OWNER,
        actorId: 's1',
      });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(3); // SET lock_timeout, advisory lock, GREATEST update
    });

    it('handles explicit evidenceId link, autoLink single/0 candidates, non-fraud reject, and invalid proof states', async () => {
      const { service, tx } = makeOverrideDeps();

      tx.proof.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.confirmProof({
          sellerId: 's1',
          proofId: 'missing',
          actorRole: DecisionActor.OWNER,
          actorId: 's1',
        }),
      ).rejects.toThrow(NotFoundException);

      tx.proof.findFirst.mockResolvedValueOnce({
        id: 'p_done',
        sellerId: 's1',
        status: ProofStatus.CONFIRMED,
        seller: { matchWindowBeforeMs: 900_000, matchWindowAfterMs: 1_800_000 },
      });
      await expect(
        service.confirmProof({
          sellerId: 's1',
          proofId: 'p_done',
          actorRole: DecisionActor.OWNER,
          actorId: 's1',
        }),
      ).rejects.toThrow(ConflictException);

      // Single auto-link success
      tx.proof.findFirst.mockResolvedValueOnce({
        id: 'p_link',
        sellerId: 's1',
        status: ProofStatus.WAITING,
        extractedAmountPiasters: 65000n,
        extractedTime: null,
        createdAt: new Date(),
        replyToPhone: '+201099999999',
        customer: null,
        seller: { matchWindowBeforeMs: 900_000, matchWindowAfterMs: 1_800_000 },
      });
      tx.$queryRaw.mockResolvedValueOnce([{ id: 'ev_sole' }]);
      tx.evidence.findFirst.mockResolvedValueOnce({ id: 'ev_sole' });

      await service.confirmProof({
        sellerId: 's1',
        proofId: 'p_link',
        actorRole: DecisionActor.MODERATOR,
        actorId: 'mod_1',
        autoLinkSingleCandidate: true,
      });
      expect(tx.evidence.update).toHaveBeenCalledWith({
        where: { id: 'ev_sole' },
        data: { claimedByProofId: 'p_link' },
      });

      // 0 candidates rejected under autoLinkSingleCandidate
      tx.proof.findFirst.mockResolvedValueOnce({
        id: 'p_none',
        sellerId: 's1',
        status: ProofStatus.WAITING,
        extractedAmountPiasters: 65000n,
        extractedTime: new Date(),
        createdAt: new Date(),
        replyToPhone: null,
        customer: null,
        seller: { matchWindowBeforeMs: 900_000, matchWindowAfterMs: 1_800_000 },
      });
      tx.$queryRaw.mockResolvedValueOnce([]);
      await expect(
        service.confirmProof({
          sellerId: 's1',
          proofId: 'p_none',
          actorRole: DecisionActor.OWNER,
          actorId: 's1',
          autoLinkSingleCandidate: true,
        }),
      ).rejects.toThrow(/No matching unclaimed deposit/);

      // Non-fraud reject without customerId
      tx.$executeRaw.mockClear();
      tx.proof.findFirst.mockResolvedValueOnce({
        id: 'p_rej',
        sellerId: 's1',
        status: ProofStatus.WAITING,
        customerId: null,
      });
      await service.rejectProof({
        sellerId: 's1',
        proofId: 'p_rej',
        actorRole: DecisionActor.OWNER,
        actorId: 's1',
        isFraud: false,
      });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe('MatchingProcessor', () => {
    it('processes owner-action before advisory lock and sends UnrecoverableError feedback on conflict', async () => {
      const prisma = {
        proof: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'p1',
            sellerId: 's1',
            status: ProofStatus.SUSPICIOUS,
            seller: { id: 's1', ownerPhone: '+201099999999', members: [] },
          }),
        },
        $transaction: vi.fn(),
      };
      const manualOverride = {
        confirmProof: vi.fn().mockRejectedValue(new ConflictException('Multiple candidate deposits')),
        rejectProof: vi.fn(),
      };
      const repliesQueue = { add: vi.fn() };
      const processor = new MatchingProcessor(
        prisma as never,
        {} as never,
        manualOverride as never,
        {} as never,
        repliesQueue as never,
      );

      await expect(
        processor.process({
          name: 'owner-action',
          data: { proofId: 'p1', verb: 'CONFIRM', senderPhone: '+201099999999' },
        } as never),
      ).rejects.toThrow(UnrecoverableError);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(repliesQueue.add).toHaveBeenCalledWith(
        'owner-action-feedback',
        expect.objectContaining({ message: 'Multiple candidate deposits' }),
      );
    });

    it('delays match-proof with jitter when pg_try_advisory_xact_lock returns false', async () => {
      const prisma = {
        $transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) =>
          cb({
            $queryRaw: vi.fn().mockResolvedValue([{ locked: false }]),
          }),
        ),
      };
      const processor = new MatchingProcessor(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const job = {
        name: 'match-proof',
        data: { sellerId: 's1', proofId: 'p1' },
        moveToDelayed: vi.fn().mockResolvedValue(undefined),
      };

      await expect(processor.process(job as never, 'tok_1')).rejects.toThrow(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok_1');
    });

    it('transitions only incoming retry proof to SUPERSEDED on self-retry without modifying original proof', async () => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
        proof: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'p_retry',
            sellerId: 's1',
            customerId: 'c1',
            isForwarded: false,
            replyToPhone: null,
            extractedRef: 'REF1',
            extractedAmountPiasters: 65000n,
            imageSha256: 'sha1',
            imagePhash: 10n,
            status: ProofStatus.PROCESSING,
            seller: {
              id: 's1',
              ownerPhone: '+201099999999',
              matchWindowBeforeMs: 900_000,
              matchWindowAfterMs: 1_800_000,
              waitingDebounceMs: 20_000,
              retentionDays: 14,
            },
            customer: { id: 'c1', phone: '+201012345678' },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };
      const prisma = { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) };
      const duplicates = {
        check: vi.fn().mockResolvedValue({
          kind: 'SELF_RETRY_ALREADY_CONFIRMED',
          originalProofId: 'p_orig',
        }),
      };
      const repliesQueue = { add: vi.fn() };
      const processor = new MatchingProcessor(
        prisma as never,
        duplicates as never,
        {} as never,
        {} as never,
        repliesQueue as never,
      );

      await processor.process({
        name: 'match-proof',
        data: { sellerId: 's1', proofId: 'p_retry' },
      } as never);

      expect(tx.proof.update).toHaveBeenCalledWith({
        where: { id: 'p_retry' },
        data: { status: ProofStatus.SUPERSEDED, statusReason: 'SELF_RETRY_ALREADY_CONFIRMED' },
      });
      expect(repliesQueue.add).toHaveBeenCalledWith(
        'customer-confirmed',
        expect.objectContaining({ proofId: 'p_retry' }),
      );
    });

    it('runs atomic updateMany on expire-waiting-proof without advisory lock', async () => {
      const tx = {
        proof: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({
            id: 'p_wait',
            sellerId: 's1',
            replyToPhone: null,
            expiresAt: new Date(),
            seller: { ownerPhone: '+201099999999' },
            customer: { phone: '+201012345678' },
          }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };
      const prisma = { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) };
      const repliesQueue = { add: vi.fn() };
      const processor = new MatchingProcessor(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        repliesQueue as never,
      );

      await processor.process({
        name: 'expire-waiting-proof',
        data: { sellerId: 's1', proofId: 'p_wait' },
      } as never);

      expect(tx.proof.updateMany).toHaveBeenCalledWith({
        where: { id: 'p_wait', status: ProofStatus.WAITING },
        data: { status: ProofStatus.UNMATCHED, statusReason: 'EVIDENCE_TIMEOUT' },
      });
      expect(repliesQueue.add).toHaveBeenCalledWith(
        'owner-alert',
        expect.objectContaining({ reasonCode: 'EVIDENCE_TIMEOUT' }),
      );
    });

    it('auto-confirms matching proof on Tier 1 ref, sends post-commit customer reply, and evaluates WAITING + 24h UNMATCHED on match-evidence', async () => {
      const now = new Date('2026-11-26T10:00:00.000Z');
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ locked: true }])
          .mockResolvedValueOnce([{ count: 0n }])
          .mockResolvedValueOnce([
            {
              id: 'ev_1',
              parsedAmountPiasters: 65000n,
              parsedRef: 'IPN12345678',
              parsedTime: now,
              parsedSender: 'sara@instapay',
              parseConfidence: 0.99,
              receivedAt: now,
            },
          ]),
        proof: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'p_match',
            sellerId: 's1',
            customerId: 'c1',
            isForwarded: false,
            replyToPhone: null,
            extractedRef: 'IPN12345678',
            extractedAmountPiasters: 65000n,
            extractedTime: now,
            extractedSender: 'sara',
            createdAt: now,
            imageSha256: 'sha1',
            imagePhash: 10n,
            status: ProofStatus.PROCESSING,
            extractionRaw: {},
            seller: {
              id: 's1',
              ownerPhone: '+201099999999',
              matchWindowBeforeMs: 900_000,
              matchWindowAfterMs: 1_800_000,
              waitingDebounceMs: 20_000,
              retentionDays: 14,
            },
            customer: { id: 'c1', phone: '+201012345678' },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        evidence: { update: vi.fn().mockResolvedValue({}) },
        match: { create: vi.fn().mockResolvedValue({}) },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };
      const prisma = {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        evidence: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce({ id: 'ev_1', parsedAmountPiasters: 65000n, claimedByProofId: null })
            .mockResolvedValueOnce({ claimedByProofId: 'p_match' }),
        },
        proof: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'p_match' }]),
        },
      };
      const duplicates = { check: vi.fn().mockResolvedValue({ kind: 'NONE' }) };
      const matchingQueue = { remove: vi.fn(), add: vi.fn() };
      const repliesQueue = { remove: vi.fn(), add: vi.fn() };
      const processor = new MatchingProcessor(
        prisma as never,
        duplicates as never,
        {} as never,
        matchingQueue as never,
        repliesQueue as never,
      );

      await processor.process({
        name: 'match-evidence',
        data: { sellerId: 's1', evidenceId: 'ev_1' },
      } as never);

      expect(tx.evidence.update).toHaveBeenCalledWith({
        where: { id: 'ev_1' },
        data: { claimedByProofId: 'p_match' },
      });
      expect(repliesQueue.add).toHaveBeenCalledWith(
        'customer-confirmed',
        expect.objectContaining({ proofId: 'p_match', customerPhone: '+201012345678' }),
      );
    });

    it('handles owner REJECT, FRAUD_DUPLICATE, WAITING debounce, SUSPICIOUS outcome, and 24h UNMATCHED evidence pass', async () => {
      const now = new Date('2026-11-26T10:00:00.000Z');
      const manualOverride = { confirmProof: vi.fn(), rejectProof: vi.fn().mockResolvedValue({ ok: true }) };
      const matchingQueue = { remove: vi.fn(), add: vi.fn() };
      const repliesQueue = { remove: vi.fn(), add: vi.fn() };
      const duplicates = { check: vi.fn() };

      const tx = {
        $queryRaw: vi.fn(),
        proof: { findUnique: vi.fn(), update: vi.fn() },
        auditLog: { create: vi.fn() },
      };
      const prisma = {
        $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        proof: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'p_act',
            sellerId: 's1',
            status: ProofStatus.WAITING,
            seller: { id: 's1', ownerPhone: '+201000000000', members: [] },
          }),
          findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'p_unm' }]),
        },
        evidence: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce({ id: 'ev_late', parsedAmountPiasters: 65000n, claimedByProofId: null })
            .mockResolvedValueOnce({ claimedByProofId: null }),
        },
      };

      const processor = new MatchingProcessor(
        prisma as never,
        duplicates as never,
        manualOverride as never,
        matchingQueue as never,
        repliesQueue as never,
      );

      // Unauthorized sender ignored silently
      await processor.process({
        name: 'owner-action',
        data: { proofId: 'p_act', verb: 'REJECT', senderPhone: '+201055555555' },
      } as never);
      expect(manualOverride.rejectProof).not.toHaveBeenCalled();

      // Valid moderator REJECT
      prisma.proof.findUnique.mockResolvedValueOnce({
        id: 'p_act',
        sellerId: 's1',
        status: ProofStatus.WAITING,
        seller: { id: 's1', ownerPhone: '+201000000000', members: [{ id: 'mod_1', role: 'MODERATOR' }] },
      });
      await processor.process({
        name: 'owner-action',
        data: { proofId: 'p_act', verb: 'REJECT', senderPhone: '+201088888888' },
      } as never);
      expect(manualOverride.rejectProof).toHaveBeenCalledTimes(1);

      // match-proof -> FRAUD_DUPLICATE
      tx.$queryRaw.mockResolvedValueOnce([{ locked: true }]);
      tx.proof.findUnique.mockResolvedValueOnce({
        id: 'p_dup',
        sellerId: 's1',
        customerId: 'c1',
        isForwarded: false,
        replyToPhone: null,
        extractedRef: 'R1',
        extractedAmountPiasters: 65000n,
        imageSha256: 's',
        imagePhash: 1n,
        status: ProofStatus.PROCESSING,
        seller: { ownerPhone: '+201000000000', retentionDays: 14 },
        customer: { id: 'c1', phone: '+201012345678' },
      });
      duplicates.check.mockResolvedValueOnce({
        kind: 'FRAUD_DUPLICATE',
        reason: 'DUPLICATE_REF',
        matchedProofId: 'p_old',
      });
      await processor.process({ name: 'match-proof', data: { sellerId: 's1', proofId: 'p_dup' } } as never);
      expect(repliesQueue.add).toHaveBeenCalledWith(
        'owner-alert',
        expect.objectContaining({ status: 'SUSPICIOUS', reasonCode: 'DUPLICATE_REF' }),
      );

      // match-proof -> WAITING transitions and queues debounced reply + expiry
      tx.$queryRaw
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([{ count: 0n }])
        .mockResolvedValueOnce([]);
      tx.proof.findUnique.mockResolvedValueOnce({
        id: 'p_wait',
        sellerId: 's1',
        customerId: 'c1',
        isForwarded: false,
        replyToPhone: null,
        extractedRef: null,
        extractedAmountPiasters: 65000n,
        extractedTime: now,
        createdAt: now,
        imageSha256: 's',
        imagePhash: 1n,
        status: ProofStatus.PROCESSING,
        extractionRaw: {},
        seller: {
          ownerPhone: '+201000000000',
          matchWindowBeforeMs: 900_000,
          matchWindowAfterMs: 1_800_000,
          waitingDebounceMs: 20_000,
          retentionDays: 14,
        },
        customer: { id: 'c1', phone: '+201012345678' },
      });
      duplicates.check.mockResolvedValueOnce({ kind: 'NONE' });
      await processor.process({ name: 'match-proof', data: { sellerId: 's1', proofId: 'p_wait' } } as never);
      expect(matchingQueue.add).toHaveBeenCalledWith(
        'expire-waiting-proof',
        { sellerId: 's1', proofId: 'p_wait' },
        expect.objectContaining({ jobId: 'expire-proof:p_wait' }),
      );

      // match-evidence 24h UNMATCHED pass does not revert when scoreAndDecide isn't CONFIRMED
      tx.$queryRaw
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([{ count: 0n }])
        .mockResolvedValueOnce([
          {
            id: 'ev_late',
            parsedAmountPiasters: 65000n,
            parsedRef: null,
            parsedTime: now,
            parsedSender: null,
            parseConfidence: 0.96,
            receivedAt: now,
          },
        ]);
      tx.proof.findUnique.mockResolvedValueOnce({
        id: 'p_unm',
        sellerId: 's1',
        customerId: null,
        isForwarded: false,
        replyToPhone: null,
        extractedRef: null,
        extractedAmountPiasters: 65000n,
        extractedTime: now,
        extractedSender: null,
        createdAt: now,
        imageSha256: 's',
        imagePhash: 1n,
        status: ProofStatus.UNMATCHED,
        extractionRaw: {},
        seller: {
          ownerPhone: '+201000000000',
          matchWindowBeforeMs: 900_000,
          matchWindowAfterMs: 1_800_000,
          waitingDebounceMs: 20_000,
          retentionDays: 14,
        },
        customer: null,
      });
      await processor.process({
        name: 'match-evidence',
        data: { sellerId: 's1', evidenceId: 'ev_late' },
      } as never);
    });
  });
});
