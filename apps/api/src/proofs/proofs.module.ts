import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WhatsAppApiClient } from '../channels/whatsapp/whatsapp-api.client.js';
import { CryptoModule } from '../common/crypto.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ProofIngestProcessor } from './proof-ingest.processor.js';
import { FallbackVisionProvider } from './vision/fallback-vision.provider.js';
import { GeminiVisionProvider } from './vision/gemini-vision.provider.js';
import { OpenAiVisionProvider } from './vision/openai-vision.provider.js';
import { VISION_PROVIDER } from './vision/vision-provider.interface.js';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    CryptoModule,
    BullModule.registerQueue(
      { name: 'proof-ingest' },
      { name: 'matching' },
      { name: 'replies' },
    ),
  ],
  providers: [
    WhatsAppApiClient,
    GeminiVisionProvider,
    OpenAiVisionProvider,
    { provide: VISION_PROVIDER, useClass: FallbackVisionProvider },
    ProofIngestProcessor,
  ],
  exports: [VISION_PROVIDER],
})
export class ProofsModule {}