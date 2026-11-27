import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class DeviceMonitorService {
  private readonly logger = new Logger(DeviceMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @InjectQueue('replies') private readonly repliesQueue: Queue,
  ) {}

  @Cron('*/5 * * * *', { name: 'device-offline-check', waitForCompletion: true })
  async checkStaleDevices(): Promise<void> {
    // Only alert during Cairo business hours (09:00 - 23:59)
    const cairoHour = DateTime.now().setZone('Africa/Cairo').hour;
    if (cairoHour < 9) return;

    // Prevent duplicate alerts across multiple API replicas
    const locked = await this.redis.set('lock:cron:device-monitor', '1', 'PX', 240_000, 'NX');
    if (!locked) return;

    const cutoff = new Date(Date.now() - 45 * 60_000); // 3 missed 15m heartbeats
    const staleDevices = await this.prisma.device.findMany({
      where: {
        lastHeartbeatAt: { lt: cutoff },
        offlineAlerted: false,
      },
      include: {
        seller: { select: { id: true, ownerPhone: true, businessName: true } },
      },
    });

    for (const device of staleDevices) {
      await this.prisma.$transaction([
        this.prisma.device.update({
          where: { id: device.id },
          data: { offlineAlerted: true },
        }),
        this.prisma.auditLog.create({
          data: {
            sellerId: device.sellerId,
            entityType: 'DEVICE',
            entityId: device.id,
            action: 'DEVICE_OFFLINE_ALERTED',
            actorType: 'SYSTEM',
            payload: { lastHeartbeatAt: device.lastHeartbeatAt.toISOString() },
          },
        }),
      ]);

      await this.repliesQueue.add('owner-device-offline', {
        sellerId: device.sellerId,
        ownerPhone: device.seller.ownerPhone,
        deviceLabel: device.deviceLabel,
      });

      this.logger.warn(`Device offline alerted: ${device.id} (seller=${device.sellerId})`);
    }
  }
}