export interface ProofForMatching {
  id: string;
  extractedAmountPiasters: bigint;
  extractedRef: string | null;
  extractedTime: Date | null;
  extractedSender: string | null;
  createdAt: Date;
  visualAnomalies: string[];
  editingSoftwareFlag: string | null;
}

export interface EvidenceCandidate {
  id: string;
  parsedAmountPiasters: bigint;
  parsedRef: string | null;
  parsedTime: Date;
  parsedSender: string | null;
  parseConfidence: number;
  receivedAt: Date;
}

export interface CandidateScore {
  evidenceId: string;
  score: number;
  refMatch: 'EXACT' | 'SUFFIX' | 'MISMATCH' | 'NONE';
  amountMatch: 'EXACT' | 'FEE_DELTA';
  nameSimilarity: number | null;
  timeDeltaSec: number;
  reasons: string[];
}

export type MatchDecision =
  | { outcome: 'CONFIRMED'; winner: CandidateScore; reasons: string[] }
  | { outcome: 'SUSPICIOUS'; reasonCode: string; candidates: CandidateScore[]; reasons: string[] }
  | { outcome: 'WAITING' };

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Compares normalized Arabic/Latin sender names or @instapay handles.
 * Returns null if either side is missing (common in bank SMS).
 */
export function computeSenderSimilarity(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;

  // Strip @instapay suffix and split into tokens
  const clean = (s: string) =>
    s
      .replace(/@instapay/g, '')
      .replace(/[._-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);

  const tokensA = clean(a);
  const tokensB = clean(b);
  if (tokensA.length === 0 || tokensB.length === 0) return null;

  // Phone number exact tail match (e.g. VF-Cash 010xxxxxxxx)
  const phoneA = a.match(/01\d{9}/)?.[0];
  const phoneB = b.match(/01\d{9}/)?.[0];
  if (phoneA && phoneB) return phoneA === phoneB ? 1.0 : 0.0;

  // Best pairwise token similarity
  let matched = 0;
  for (const ta of tokensA) {
    let best = 0;
    for (const tb of tokensB) {
      const maxLen = Math.max(ta.length, tb.length);
      const sim = 1 - levenshtein(ta, tb) / maxLen;
      if (sim > best) best = sim;
    }
    if (best >= 0.72) matched++;
  }

  return matched / Math.min(tokensA.length, tokensB.length);
}

function compareRefs(
  proofRef: string | null,
  evRef: string | null,
): 'EXACT' | 'SUFFIX' | 'MISMATCH' | 'NONE' {
  if (!proofRef || !evRef) return 'NONE';
  if (proofRef === evRef) return 'EXACT';
  if (proofRef.length >= 8 && evRef.length >= 8 && proofRef.slice(-8) === evRef.slice(-8)) {
    return 'SUFFIX';
  }
  return 'MISMATCH';
}

export function scoreAndDecide(
  proof: ProofForMatching,
  candidates: EvidenceCandidate[],
): MatchDecision {
  if (candidates.length === 0) {
    return { outcome: 'WAITING' };
  }

  const anchorTime = proof.extractedTime ?? proof.createdAt;
  const hasTamperWarning =
    proof.visualAnomalies.length > 0 || proof.editingSoftwareFlag !== null;

  const scored: CandidateScore[] = candidates.map((ev) => {
    const reasons: string[] = [];
    let score = 0;

    const amountDiff =
      ev.parsedAmountPiasters > proof.extractedAmountPiasters
        ? ev.parsedAmountPiasters - proof.extractedAmountPiasters
        : proof.extractedAmountPiasters - ev.parsedAmountPiasters;

    const amountMatch: 'EXACT' | 'FEE_DELTA' = amountDiff === 0n ? 'EXACT' : 'FEE_DELTA';
    if (amountMatch === 'EXACT') {
      score += 40;
      reasons.push('EXACT_AMOUNT');
    } else {
      score += 10;
      reasons.push(`AMOUNT_DELTA_PIASTERS_${amountDiff.toString()}`);
    }

    const refMatch = compareRefs(proof.extractedRef, ev.parsedRef);
    if (refMatch === 'EXACT') {
      score += 50;
      reasons.push('EXACT_REF');
    } else if (refMatch === 'SUFFIX') {
      score += 40;
      reasons.push('SUFFIX_REF_8');
    } else if (refMatch === 'MISMATCH') {
      score -= 40;
      reasons.push('REF_MISMATCH');
    }

    const timeDeltaSec = Math.round(
      Math.abs(ev.receivedAt.getTime() - anchorTime.getTime()) / 1000,
    );
    if (timeDeltaSec <= 180) {
      score += 15;
      reasons.push(`TIME_DELTA_${timeDeltaSec}S`);
    } else if (timeDeltaSec <= 900) {
      score += 8;
      reasons.push(`TIME_DELTA_${timeDeltaSec}S`);
    } else {
      reasons.push(`TIME_DELTA_${timeDeltaSec}S`);
    }

    const nameSimilarity = computeSenderSimilarity(proof.extractedSender, ev.parsedSender);
    if (nameSimilarity !== null) {
      if (nameSimilarity >= 0.7) {
        score += 15;
        reasons.push(`SENDER_MATCH_${Math.round(nameSimilarity * 100)}`);
      } else if (nameSimilarity <= 0.2) {
        score -= 25;
        reasons.push(`SENDER_MISMATCH_${Math.round(nameSimilarity * 100)}`);
      }
    }

    if (ev.parseConfidence < 0.85) {
      score -= 20;
      reasons.push('LOW_PARSER_CONFIDENCE');
    }

    return {
      evidenceId: ev.id,
      score,
      refMatch,
      amountMatch,
      nameSimilarity,
      timeDeltaSec,
      reasons,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const exactAmountScored = scored.filter((c) => c.amountMatch === 'EXACT');
  const best = scored[0];

  // Tampering advisory: never auto-confirm when image forensics flagged edits
  if (hasTamperWarning) {
    const flags = [
      ...proof.visualAnomalies.map((a) => `VISUAL_${a.toUpperCase()}`),
      ...(proof.editingSoftwareFlag ? [`EXIF_${proof.editingSoftwareFlag.toUpperCase()}`] : []),
    ];
    return {
      outcome: 'SUSPICIOUS',
      reasonCode: 'VISUAL_TAMPER_WARNING',
      candidates: scored.slice(0, 3),
      reasons: [...best.reasons, ...flags],
    };
  }

  // TIER 1: Deterministic exact amount + exact/suffix reference match
  const tier1Matches = exactAmountScored.filter(
    (c) =>
      (c.refMatch === 'EXACT' || c.refMatch === 'SUFFIX') &&
      !c.reasons.includes('LOW_PARSER_CONFIDENCE'),
  );
  if (tier1Matches.length === 1) {
    return {
      outcome: 'CONFIRMED',
      winner: tier1Matches[0],
      reasons: ['TIER_1_REF_MATCH', ...tier1Matches[0].reasons],
    };
  }

  // TIER 2: Single unclaimed exact-amount candidate with no contradictions
  if (exactAmountScored.length === 1) {
    const only = exactAmountScored[0];
    const hasContradiction =
      only.refMatch === 'MISMATCH' ||
      (only.nameSimilarity !== null && only.nameSimilarity <= 0.2) ||
      only.reasons.includes('LOW_PARSER_CONFIDENCE');

    if (!hasContradiction) {
      return {
        outcome: 'CONFIRMED',
        winner: only,
        reasons: ['TIER_2_UNIQUE_AMOUNT_WINDOW', ...only.reasons],
      };
    }

    return {
      outcome: 'SUSPICIOUS',
      reasonCode: only.refMatch === 'MISMATCH' ? 'REF_MISMATCH' : 'SENDER_OR_CONFIDENCE_CHECK',
      candidates: [only],
      reasons: only.reasons,
    };
  }

  // TIER 3: Multiple exact-amount candidates (collision) or fee-delta-only candidates
  const reasonCode =
    exactAmountScored.length > 1 ? 'AMBIGUOUS_MULTIPLE_EVIDENCE' : 'AMOUNT_FEE_MISMATCH';

  return {
    outcome: 'SUSPICIOUS',
    reasonCode,
    candidates: scored.slice(0, 5),
    reasons: [reasonCode, ...best.reasons],
  };
}