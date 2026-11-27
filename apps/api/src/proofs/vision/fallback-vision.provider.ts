import { Injectable, Logger } from '@nestjs/common';
import { GeminiVisionProvider } from './gemini-vision.provider.js';
import { OpenAiVisionProvider } from './openai-vision.provider.js';
import { VisionProvider, VisionProviderOutput } from './vision-provider.interface.js';

@Injectable()
export class FallbackVisionProvider implements VisionProvider {
  readonly name = 'fallback';
  private readonly logger = new Logger(FallbackVisionProvider.name);
  private readonly providers: VisionProvider[];

  constructor(
    gemini: GeminiVisionProvider,
    openai: OpenAiVisionProvider,
  ) {
    // Swap primary via VISION_PRIMARY=openai if needed
    this.providers =
      process.env.VISION_PRIMARY === 'openai' ? [openai, gemini] : [gemini, openai];
  }

  async extractReceipt(imageBuffer: Buffer, mimeType: string): Promise<VisionProviderOutput> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        return await Promise.race([
          provider.extractReceipt(imageBuffer, mimeType),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${provider.name} timeout`)), 15_000),
          ),
        ]);
      } catch (err) {
        lastError = err;
        this.logger.warn(`Vision provider ${provider.name} failed: ${(err as Error).message}`);
      }
    }
    throw lastError;
  }
}