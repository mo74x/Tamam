import { EvidenceCandidate, ProofForMatching, scoreAndDecide } from './scoring.js';

describe('3-Tier Matching & Scoring Engine', () => {
  const baseTime = new Date('2026-11-26T10:00:00.000Z');

  const makeProof = (overrides: Partial<ProofForMatching> = {}): ProofForMatching => ({
    id: 'proof_1',
    extractedAmountPiasters: 65000n, // 650.00 EGP hoodie
    extractedRef: null,
    extractedTime: baseTime,
    extractedSender: 'sara ali',
    createdAt: baseTime,
    visualAnomalies: [],
    editingSoftwareFlag: null,
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

  it('Tier 1: auto-confirms by exact reference even when 2 buyers paid the same 650 EGP', () => {
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
  });

  it('Tier 2: auto-confirms single unclaimed exact-amount bank SMS without reference', () => {
    const decision = scoreAndDecide(makeProof(), [makeEvidence('ev_only')]);
    expect(decision.outcome).toBe('CONFIRMED');
  });

  it('Tier 3: flags AMBIGUOUS_MULTIPLE_EVIDENCE during a 650 EGP hoodie drop without ref IDs', () => {
    const decision = scoreAndDecide(makeProof(), [
      makeEvidence('ev_1', { parsedSender: null }),
      makeEvidence('ev_2', { parsedSender: null }),
    ]);

    expect(decision.outcome).toBe('SUSPICIOUS');
    if (decision.outcome === 'SUSPICIOUS') {
      expect(decision.reasonCode).toBe('AMBIGUOUS_MULTIPLE_EVIDENCE');
    }
  });

  it('downgrades to SUSPICIOUS if EXIF editing software or visual anomalies exist', () => {
    const decision = scoreAndDecide(
      makeProof({ extractedRef: 'IPN12345678', editingSoftwareFlag: 'canva' }),
      [makeEvidence('ev_1', { parsedRef: 'IPN12345678' })],
    );

    expect(decision.outcome).toBe('SUSPICIOUS');
    if (decision.outcome === 'SUSPICIOUS') {
      expect(decision.reasonCode).toBe('VISUAL_TAMPER_WARNING');
    }
  });

  it('never auto-confirms low-confidence llm_fallback evidence', () => {
    const decision = scoreAndDecide(makeProof(), [
      makeEvidence('ev_llm', { parseConfidence: 0.65 }),
    ]);
    expect(decision.outcome).toBe('SUSPICIOUS');
  });
});