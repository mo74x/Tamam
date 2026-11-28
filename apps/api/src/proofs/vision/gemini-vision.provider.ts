import { Injectable } from '@nestjs/common';
import { AiClientService } from '../../ai/ai-client.service.js';
import { VisionProvider, VisionProviderOutput } from './vision-provider.interface.js';
import {
  RECEIPT_EXTRACTION_PROMPT,
  VISION_JSON_SCHEMA,
  VisionExtractionSchema,
} from './vision.schema.js';

@Injectable()
export class GeminiVisionProvider implements VisionProvider {
  readonly name = 'gemini';

  constructor(private readonly aiClient: AiClientService) {}

  async extractReceipt(imageBuffer: Buffer, mimeType: string): Promise<VisionProviderOutput> {
    const res = await this.aiClient.extractVision({
      provider: 'gemini',
      imageBuffer,
      mimeType,
      prompt: RECEIPT_EXTRACTION_PROMPT,
      jsonSchema: VISION_JSON_SCHEMA as unknown as Record<string, unknown>,
    });

    const parsed = VisionExtractionSchema.parse(JSON.parse(res.rawText));
    return {
      provider: res.provider,
      model: res.model,
      latencyMs: res.latencyMs,
      estimatedCostMicroUsd: res.estimatedCostMicroUsd,
      data: parsed,
    };
  }
}
