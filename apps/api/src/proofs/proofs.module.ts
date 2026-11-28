import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../channels/whatsapp/whatsapp.module.js';
import { ProofIngestProcessor } from './proof-ingest.processor.js';
import { FallbackVisionProvider } from './vision/fallback-vision.provider.js';
import { GeminiVisionProvider } from './vision/gemini-vision.provider.js';
import { OpenAiVisionProvider } from './vision/openai-vision.provider.js';
import { VISION_PROVIDER } from './vision/vision-provider.interface.js';

@Module({
  imports: [
    WhatsAppModule,
    BullModule.registerQueue(
      { name: 'proof-ingest' },
      { name: 'matching' },
      { name: 'replies' },
    ),
  ],
  providers: [
    GeminiVisionProvider,
    OpenAiVisionProvider,
    FallbackVisionProvider,
    { provide: VISION_PROVIDER, useExisting: FallbackVisionProvider },
    ProofIngestProcessor,
  ],
  exports: [VISION_PROVIDER],
})
export class ProofsModule {}
