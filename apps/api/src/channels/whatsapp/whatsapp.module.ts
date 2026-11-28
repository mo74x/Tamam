import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WhatsAppApiClient } from './whatsapp-api.client.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller.js';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'proof-ingest' },
      { name: 'matching' },
      { name: 'replies' },
    ),
  ],
  controllers: [WhatsAppWebhookController],
  providers: [WhatsAppSignatureGuard, WhatsAppApiClient],
  exports: [WhatsAppApiClient],
})
export class WhatsAppModule {}
