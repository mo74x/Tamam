import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class SellerTokenGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      params?: { sellerId?: string };
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      sellerId?: string;
      deviceId?: string;
    }>();

    const sellerIdHeader = req.headers['x-seller-id'];
    const sellerId =
      req.params?.sellerId ?? (typeof sellerIdHeader === 'string' ? sellerIdHeader : undefined);
    const authHeaderRaw = req.headers['authorization'];
    const authHeader = typeof authHeaderRaw === 'string' ? authHeaderRaw : undefined;

    if (!sellerId || !authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing seller credentials');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Missing seller credentials');
    }

    const incomingHash = createHash('sha256').update(token).digest();

    const deviceIdHeader = req.headers['x-device-id'];
    const bodyDeviceId =
      typeof req.body === 'object' &&
      req.body !== null &&
      typeof (req.body as { deviceId?: unknown }).deviceId === 'string'
        ? (req.body as { deviceId: string }).deviceId
        : undefined;
    const deviceId =
      (typeof deviceIdHeader === 'string' && deviceIdHeader.trim() ? deviceIdHeader.trim() : undefined) ??
      bodyDeviceId;

    if (deviceId) {
      const device = await this.prisma.device.findFirst({
        where: { id: deviceId, sellerId },
        select: { id: true, tokenHash: true },
      });
      if (!device || !device.tokenHash) {
        throw new UnauthorizedException('Invalid device credentials');
      }

      const storedDeviceHash = Buffer.from(device.tokenHash, 'hex');
      if (
        incomingHash.length !== storedDeviceHash.length ||
        !timingSafeEqual(incomingHash, storedDeviceHash)
      ) {
        throw new UnauthorizedException('Invalid token');
      }

      req.sellerId = sellerId;
      req.deviceId = device.id;
      return true;
    }

    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { id: true, evidenceSecretHash: true },
    });

    if (!seller) throw new UnauthorizedException('Invalid seller');

    const storedHash = Buffer.from(seller.evidenceSecretHash, 'hex');
    if (incomingHash.length !== storedHash.length || !timingSafeEqual(incomingHash, storedHash)) {
      throw new UnauthorizedException('Invalid token');
    }

    req.sellerId = seller.id;
    return true;
  }
}
