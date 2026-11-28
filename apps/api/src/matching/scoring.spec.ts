import {
  EvidenceCandidate,
  ProofForMatching,
  computeSenderSimilarity,
  scoreAndDecide,
} from './scoring.js';

describe('3-Tier Matching & Scoring Engine', () => {
  const baseTime = new Date('2026-11-26T10:00:00.000Z');

  const makeProof = (overrides: Partial<ProofForMatching> = {}): ProofForMatching => ({
    id: 'proof_1',
    extractedAmountPiasters: 65000n,
    extractedRef: null,
    extractedTime: baseTime,
    extractedSender: 'sara ali',
    createdAt: baseTime,
    visualAnomalies: [],
    editingSoftwareFlag: null,
    competingOpenProofsCount: 0,
    ...overrides,
  });

  const makeEvidence = (
    id: string,
    overrides: Partial<EvidenceCandidate> = {},
  ): EvidenceCandidate => ({
    id,
    parsedAmountPiasters: 65000n,
    parsedRef: null,
    parsedTime: baseTime,
    parsedSender: 'sara.ali@instapay',
    parseConfidence: 0.96,
    receivedAt: new Date(baseTime.getTime() + 15_000),
    ...overrides,
  });

  it('computes cross-script Arabic/Latin similarity and treats phone-vs-name as incomparable null', () => {
    expect(computeSenderSimilarity('أحمد محمد', 'Ahmed Mohamed')).toBe(1.0);
    expect(computeSenderSimilarity('01012345678', 'Ahmed Mohamed')).toBeNull();
    expect(computeSenderSimilarity('01012345678', 'ahmed 01012345678')).toBe(1.0);
    expect(computeSenderSimilarity('01012345678', '01099999999')).toBe(0.0);
    expect(computeSenderSimilarity(null, 'Ahmed')).toBeNull();
  });

  it('returns WAITING when candidate list is empty', () => {
    expect(scoreAndDecide(makeProof(), [])).toEqual({ outcome: 'WAITING' });
  });

  it('Tier 1: auto-confirms by exact/suffix reference and rejects Tier 1 when sender contradicts', () => {
    const decision = scoreAndDecide(
      makeProof({ extractedRef: 'IPN2611998877' }),
      [
        makeEvidence('ev_other', { parsedRef: 'IPN2611000011', parsedSender: 'mona' }),
        makeEvidence('ev_right', { parsedRef: 'IPN2611998877', parsedSender: 'sara.ali@instapay' }),
      ],
    );

    expect(decision.outcome).toBe('CONFIRMED');
    if (decision.outcome === 'CONFIRMED') {
      expect(decision.winner.evidenceId).toBe('ev_right');
      expect(decision.reasons).toContain('TIER_1_REF_MATCH');
    }

    const suffix = scoreAndDecide(
      makeProof({ extractedRef: 'ABCD99887766', extractedSender: null }),
      [makeEvidence('ev_suf', { parsedRef: '99887766', parsedSender: null })],
    );
    expect(suffix.outcome).toBe('CONFIRMED');

    // Contradicting sender name blocks Tier 1 auto-confirm
    const contradicted = scoreAndDecide(
      makeProof({ extractedRef: 'IPN2611998877', extractedSender: 'kareem' }),
      [makeEvidence('ev_con', { parsedRef: 'IPN2611998877', parsedSender: 'youssef' })],
    );
    expect(contradicted.outcome).toBe('SUSPICIOUS');
  });

  it('Tier 2: enforces strict missing-reference rule (corroboration, timestamp, no competing proofs)', () => {
    expect(scoreAndDecide(makeProof(), [makeEvidence('ev_only')]).outcome).toBe('CONFIRMED');

    const noTime = scoreAndDecide(
      makeProof({ extractedTime: null }),
      [makeEvidence('ev_only', { parsedTime: null })],
    );
    expect(noTime.outcome).toBe('SUSPICIOUS');
    if (noTime.outcome === 'SUSPICIOUS') expect(noTime.reasonCode).toBe('MISSING_REF_UNCORROBORATED');

    const competing = scoreAndDecide(
      makeProof({ competingOpenProofsCount: 1 }),
      [makeEvidence('ev_only')],
    );
    expect(competing.outcome).toBe('SUSPICIOUS');

    const refMismatch = scoreAndDecide(
      makeProof({ extractedRef: 'IPN11112222' }),
      [makeEvidence('ev_only', { parsedRef: 'IPN99998888' })],
    );
    expect(refMismatch.outcome).toBe('SUSPICIOUS');
    if (refMismatch.outcome === 'SUSPICIOUS') expect(refMismatch.reasonCode).toBe('REF_MISMATCH');
  });

  it('Tier 3: differentiates AMBIGUOUS_MULTIPLE_EVIDENCE, AMOUNT_FEE_MISMATCH, and AMOUNT_MISMATCH', () => {
    const ambiguous = scoreAndDecide(makeProof(), [
      makeEvidence('ev_1', { parsedSender: null }),
      makeEvidence('ev_2', { parsedSender: null }),
    ]);
    expect(ambiguous.outcome).toBe('SUSPICIOUS');
    if (ambiguous.outcome === 'SUSPICIOUS') {
      expect(ambiguous.reasonCode).toBe('AMBIGUOUS_MULTIPLE_EVIDENCE');
    }

    const feeDelta = scoreAndDecide(makeProof(), [
      makeEvidence('ev_fee', { parsedAmountPiasters: 64500n }),
    ]);
    expect(feeDelta.outcome).toBe('SUSPICIOUS');
    if (feeDelta.outcome === 'SUSPICIOUS') {
      expect(feeDelta.reasonCode).toBe('AMOUNT_FEE_MISMATCH');
    }

    const largeMismatch = scoreAndDecide(makeProof(), [
      makeEvidence('ev_big', { parsedAmountPiasters: 50000n }),
    ]);
    expect(largeMismatch.outcome).toBe('SUSPICIOUS');
    if (largeMismatch.outcome === 'SUSPICIOUS') {
      expect(largeMismatch.reasonCode).toBe('AMOUNT_MISMATCH');
    }
  });

  it('downgrades to SUSPICIOUS on tampering or low parser confidence', () => {
    const tampered = scoreAndDecide(
      makeProof({ extractedRef: 'IPN12345678', editingSoftwareFlag: 'canva', visualAnomalies: ['edited'] }),
      [makeEvidence('ev_1', { parsedRef: 'IPN12345678' })],
    );
    expect(tampered.outcome).toBe('SUSPICIOUS');
    if (tampered.outcome === 'SUSPICIOUS') expect(tampered.reasonCode).toBe('VISUAL_TAMPER_WARNING');

    const lowConf = scoreAndDecide(makeProof(), [
      makeEvidence('ev_llm', { parseConfidence: 0.65 }),
    ]);
    expect(lowConf.outcome).toBe('SUSPICIOUS');
    if (lowConf.outcome === 'SUSPICIOUS') {
      expect(lowConf.reasonCode).toBe('SENDER_OR_CONFIDENCE_CHECK');
    }
  });
});
