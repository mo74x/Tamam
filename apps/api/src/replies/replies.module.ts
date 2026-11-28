import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../channels/whatsapp/whatsapp.module.js';
import { RepliesProcessor } from './replies.processor.js';

@Module({
  imports: [WhatsAppModule, BullModule.registerQueue({ name: 'replies' })],
  providers: [RepliesProcessor],
})
export class RepliesModule {}
