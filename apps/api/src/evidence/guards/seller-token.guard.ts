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
    const req = ctx.switchToHttp().getRequest();
    const sellerId: string | undefined = req.params?.sellerId ?? req.headers['x-seller-id'];
    const authHeader: string | undefined = req.headers['authorization'];

    if (!sellerId || !authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing seller credentials');
    }

    const token = authHeader.slice(7).trim();
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { id: true, evidenceSecretHash: true },
    });

    if (!seller) throw new UnauthorizedException('Invalid seller');

    const incomingHash = createHash('sha256').update(token).digest();
    const storedHash = Buffer.from(seller.evidenceSecretHash, 'hex');

    if (incomingHash.length !== storedHash.length || !timingSafeEqual(incomingHash, storedHash)) {
      throw new UnauthorizedException('Invalid token');
    }

    req.sellerId = seller.id;
    return true;
  }
}