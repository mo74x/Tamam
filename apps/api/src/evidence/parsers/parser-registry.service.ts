import { Injectable } from '@nestjs/common';
import { toAsciiDigits } from '../../common/normalize.js';
import { CibParser, InstaPayParser, NbeParser, VodafoneCashParser } from './egypt-parsers.js';
import { LlmEvidenceFallbackService } from './llm-fallback.service.js';
import { EvidenceParser, ParsedEvidence } from './parser.interface.js';

export interface ParserRegistryOptions {
  allowUnscopedFallback?: boolean;
  sellerId?: string;
}

@Injectable()
export class ParserRegistryService {
  private readonly parsers: EvidenceParser[] = [
    new InstaPayParser(),
    new VodafoneCashParser(),
    new CibParser(),
    new NbeParser(),
  ];

  constructor(private readonly llmFallback: LlmEvidenceFallbackService) {}

  async parse(
    senderApp: string | null,
    rawText: string,
    receivedAt: Date,
    options?: ParserRegistryOptions,
  ): Promise<ParsedEvidence | null> {
    const normalized = toAsciiDigits(rawText).replace(/\s+/g, ' ').trim();

    for (const parser of this.parsers) {
      if (!parser.supports(senderApp, normalized)) continue;
      const result = parser.parse(normalized, receivedAt);
      if (result) return result;
    }

    // Secondary Pass-2 unscoped regex scan runs ONLY when explicitly allowed (MANUAL_PASTE)
    if (options?.allowUnscopedFallback) {
      for (const parser of this.parsers) {
        const result = parser.parse(normalized, receivedAt);
        if (result) return result;
      }
    }

    return this.llmFallback.parse(normalized, receivedAt, {
      sellerId: options?.sellerId,
      senderApp,
    });
  }
}
