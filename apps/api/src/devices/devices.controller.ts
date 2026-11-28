import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SellerTokenGuard } from '../evidence/guards/seller-token.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

const HeartbeatSchema = z.object({
  deviceId: z.string().cuid().optional(),
  deviceLabel: z.string().min(2).max(80),
  appVersion: z.string().min(1).max(20),
});

@Controller('devices')
export class DevicesController {
  constructor(private readonly prisma: PrismaService) {}

  @Post(':sellerId/heartbeat')
  @UseGuards(SellerTokenGuard)
  async heartbeat(@Param('sellerId') sellerId: string, @Body() body: unknown) {
    const parsed = HeartbeatSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const { deviceId, deviceLabel, appVersion } = parsed.data;
    const now = new Date();

    let resolvedId: string;
    if (deviceId) {
      const updated = await this.prisma.device.updateMany({
        where: { id: deviceId, sellerId },
        data: { lastHeartbeatAt: now, appVersion, offlineAlerted: false },
      });
      if (updated.count === 0) {
        throw new NotFoundException('Device not found for seller');
      }
      resolvedId = deviceId;
    } else {
      const device = await this.prisma.device.upsert({
        where: { sellerId_deviceLabel: { sellerId, deviceLabel } },
        update: { appVersion, lastHeartbeatAt: now, offlineAlerted: false },
        create: { sellerId, deviceLabel, appVersion, lastHeartbeatAt: now },
      });
      resolvedId = device.id;
    }

    return {
      ok: true,
      deviceId: resolvedId,
      serverTime: now.toISOString(),
      nextHeartbeatSec: 900, // 15 minutes
    };
  }
}
