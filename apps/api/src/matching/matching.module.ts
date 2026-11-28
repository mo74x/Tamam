import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DuplicateDetectorService } from './duplicate-detector.service.js';
import { ManualOverrideService } from './manual-override.service.js';
import { MatchingProcessor } from './matching.processor.js';

@Module({
  imports: [BullModule.registerQueue({ name: 'matching' }, { name: 'replies' })],
  providers: [DuplicateDetectorService, MatchingProcessor, ManualOverrideService],
  exports: [ManualOverrideService],
})
export class MatchingModule {}
