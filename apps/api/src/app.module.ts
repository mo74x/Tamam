import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { createObserveModule } from '@nestjs/observe';
import { AiModule } from './ai/ai.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { WhatsAppModule } from './channels/whatsapp/whatsapp.module.js';
import { CryptoModule } from './common/crypto.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { EvidenceModule } from './evidence/evidence.module.js';
import { MatchingModule } from './matching/matching.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProofsModule } from './proofs/proofs.module.js';
import { RedisModule } from './redis/redis.module.js';
import { RepliesModule } from './replies/replies.module.js';
import { StorageModule } from './storage/storage.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'api',
    }),
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    CryptoModule,
    StorageModule,
    AiModule,
    EvidenceModule,
    DevicesModule,
    WhatsAppModule,
    ProofsModule,
    MatchingModule,
    RepliesModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
