import { transliterateArabicLatinSkeleton } from '../common/normalize.js';

export interface ProofForMatching {
  id: string;
  extractedAmountPiasters: bigint;
  extractedRef: string | null;
  extractedTime: Date | null;
  extractedSender: string | null;
  createdAt: Date;
  visualAnomalies: string[];
  editingSoftwareFlag: string | null;
  competingOpenProofsCount?: number;
}

export interface EvidenceCandidate {
  id: string;
  parsedAmountPiasters: bigint;
  parsedRef: string | null;
  parsedTime: Date | null;
  parsedSender: string | null;
  parseConfidence: number;
  receivedAt: Date;
}

export interface CandidateScore {
  evidenceId: string;
  score: number;
  refMatch: 'EXACT' | 'SUFFIX' | 'MISMATCH' | 'NONE';
  amountMatch: 'EXACT' | 'FEE_DELTA' | 'MISMATCH';
  nameSimilarity: number | null;
  timeDeltaSec: number;
  reasons: string[];
}

export type MatchDecision =
  | { outcome: 'CONFIRMED'; winner: CandidateScore; reasons: string[] }
  | { outcome: 'SUSPICIOUS'; reasonCode: string; candidates: CandidateScore[]; reasons: string[] }
  | { outcome: 'WAITING' };

const FEE_TOLERANCE_PIASTERS = 1500n;
const PHONE_RE = /01\d{9}/;

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

function isPhoneOnlyTokens(tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
}

function hasAlphaTokens(tokens: string[]): boolean {
  return tokens.some((t) => /[a-z\u0621-\u064A]/i.test(t));
}

/**
 * Compares normalized Arabic/Latin sender names or @instapay handles.
 * Returns null if either side is missing or comparing phone-only vs alphabetic-only strings.
 */
export function computeSenderSimilarity(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;

  const clean = (s: string) =>
    s
      .replace(/@instapay/g, '')
      .replace(/[._-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);

  const tokensA = clean(a);
  const tokensB = clean(b);
  if (tokensA.length === 0 || tokensB.length === 0) return null;

  const phoneA = a.match(PHONE_RE)?.[0];
  const phoneB = b.match(PHONE_RE)?.[0];
  if (phoneA && phoneB) return phoneA === phoneB ? 1.0 : 0.0;

  if (
    (isPhoneOnlyTokens(tokensA) && !phoneB && hasAlphaTokens(tokensB)) ||
    (isPhoneOnlyTokens(tokensB) && !phoneA && hasAlphaTokens(tokensA))
  ) {
    return null;
  }

  let matched = 0;
  for (const ta of tokensA) {
    const skelA = transliterateArabicLatinSkeleton(ta);
    let best = 0;
    for (const tb of tokensB) {
      const maxLen = Math.max(ta.length, tb.length);
      const rawSim = 1 - levenshtein(ta, tb) / maxLen;

      const skelB = transliterateArabicLatinSkeleton(tb);
      let skelSim = 0;
      if (skelA.length > 0 && skelB.length > 0) {
        skelSim =
          skelA === skelB
            ? 1.0
            : 1 - levenshtein(skelA, skelB) / Math.max(skelA.length, skelB.length);
      }

      const sim = Math.max(rawSim, skelSim);
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
  const timestampFallback = proof.extractedTime === null;
  const competingOpenProofsCount = proof.competingOpenProofsCount ?? 0;
  const hasTamperWarning =
    proof.visualAnomalies.length > 0 || proof.editingSoftwareFlag !== null;

  const scored: CandidateScore[] = candidates.map((ev) => {
    const reasons: string[] = [];
    let score = 0;

    const amountDiff =
      ev.parsedAmountPiasters > proof.extractedAmountPiasters
        ? ev.parsedAmountPiasters - proof.extractedAmountPiasters
        : proof.extractedAmountPiasters - ev.parsedAmountPiasters;

    const amountMatch: 'EXACT' | 'FEE_DELTA' | 'MISMATCH' =
      amountDiff === 0n ? 'EXACT' : amountDiff <= FEE_TOLERANCE_PIASTERS ? 'FEE_DELTA' : 'MISMATCH';
    if (amountMatch === 'EXACT') {
      score += 40;
      reasons.push('EXACT_AMOUNT');
    } else if (amountMatch === 'FEE_DELTA') {
      score += 10;
      reasons.push(`AMOUNT_DELTA_PIASTERS_${amountDiff.toString()}`);
    } else {
      score -= 50;
      reasons.push('AMOUNT_MISMATCH');
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

    const evTime = ev.parsedTime ?? ev.receivedAt;
    const timeDeltaSec = Math.round(Math.abs(evTime.getTime() - anchorTime.getTime()) / 1000);
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

  // TIER 1: Single unclaimed exact-amount candidate matching ref without sender contradiction
  const tier1Matches = exactAmountScored.filter(
    (c) =>
      (c.refMatch === 'EXACT' || c.refMatch === 'SUFFIX') &&
      !c.reasons.includes('LOW_PARSER_CONFIDENCE') &&
      (c.nameSimilarity === null || c.nameSimilarity > 0.2),
  );
  if (tier1Matches.length === 1) {
    return {
      outcome: 'CONFIRMED',
      winner: tier1Matches[0],
      reasons: ['TIER_1_REF_MATCH', ...tier1Matches[0].reasons],
    };
  }

  // Single exact-amount conflict & Tier 2 strict missing-reference rule
  if (exactAmountScored.length === 1) {
    const only = exactAmountScored[0];
    if (only.refMatch === 'MISMATCH') {
      return {
        outcome: 'SUSPICIOUS',
        reasonCode: 'REF_MISMATCH',
        candidates: [only],
        reasons: only.reasons,
      };
    }

    if (
      only.reasons.includes('LOW_PARSER_CONFIDENCE') ||
      (only.nameSimilarity !== null && only.nameSimilarity <= 0.2)
    ) {
      return {
        outcome: 'SUSPICIOUS',
        reasonCode: 'SENDER_OR_CONFIDENCE_CHECK',
        candidates: [only],
        reasons: only.reasons,
      };
    }

    const identityCorroborated = only.nameSimilarity !== null && only.nameSimilarity >= 0.7;
    if (!timestampFallback && competingOpenProofsCount === 0 && identityCorroborated) {
      return {
        outcome: 'CONFIRMED',
        winner: only,
        reasons: ['TIER_2_UNIQUE_AMOUNT_WINDOW', ...only.reasons],
      };
    }

    return {
      outcome: 'SUSPICIOUS',
      reasonCode: 'MISSING_REF_UNCORROBORATED',
      candidates: [only],
      reasons: ['MISSING_REF_UNCORROBORATED', ...only.reasons],
    };
  }

  // TIER 3: Multiple exact-amount candidates, small fee tolerance, or large amount mismatch
  const reasonCode =
    exactAmountScored.length > 1
      ? 'AMBIGUOUS_MULTIPLE_EVIDENCE'
      : scored.some((c) => c.amountMatch === 'FEE_DELTA')
        ? 'AMOUNT_FEE_MISMATCH'
        : 'AMOUNT_MISMATCH';

  return {
    outcome: 'SUSPICIOUS',
    reasonCode,
    candidates: scored.slice(0, 5),
    reasons: [reasonCode, ...best.reasons],
  };
}
