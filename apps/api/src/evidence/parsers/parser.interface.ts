export interface ParsedEvidence {
  amountPiasters: bigint;
  ref: string | null;
  sender: string | null;
  time: Date | null;
  parserName: string;
  confidence: number; // 0.0 - 1.0
}

export interface EvidenceParser {
  readonly name: string;
  supports(senderApp: string | null, normalizedText: string): boolean;
  parse(normalizedText: string, receivedAt: Date): ParsedEvidence | null;
}