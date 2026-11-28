import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module.js';
import { DeviceMonitorService } from './device-monitor.service.js';
import { DevicesController } from './devices.controller.js';

@Module({
  imports: [EvidenceModule, BullModule.registerQueue({ name: 'replies' })],
  controllers: [DevicesController],
  providers: [DeviceMonitorService],
})
export class DevicesModule {}
