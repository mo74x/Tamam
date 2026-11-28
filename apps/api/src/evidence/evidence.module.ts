import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceIngestProcessor } from './evidence.processor.js';
import { EvidenceService } from './evidence.service.js';
import { SellerTokenGuard } from './guards/seller-token.guard.js';
import { LlmEvidenceFallbackService } from './parsers/llm-fallback.service.js';
import { ParserRegistryService } from './parsers/parser-registry.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: 'evidence-ingest' }, { name: 'matching' })],
  controllers: [EvidenceController],
  providers: [
    EvidenceService,
    EvidenceIngestProcessor,
    ParserRegistryService,
    LlmEvidenceFallbackService,
    SellerTokenGuard,
  ],
  exports: [EvidenceService, SellerTokenGuard],
})
export class EvidenceModule {}
