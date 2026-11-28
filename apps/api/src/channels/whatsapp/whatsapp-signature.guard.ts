import {
  CanActivate,
  ExecutionContext,
  Injectable,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

@Injectable()
export class WhatsAppSignatureGuard implements CanActivate {
  private get appSecret(): string {
    return process.env.META_APP_SECRET ?? '';
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const sigHeader = req.headers['x-hub-signature-256'];

    if (!this.appSecret || typeof sigHeader !== 'string' || !sigHeader.startsWith('sha256=')) {
      throw new UnauthorizedException('Missing WhatsApp webhook signature');
    }

    if (!req.rawBody) {
      throw new UnauthorizedException('Raw request body unavailable');
    }

    const expectedHex = createHmac('sha256', this.appSecret).update(req.rawBody).digest('hex');
    const providedHex = sigHeader.slice(7);

    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(providedHex, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid WhatsApp webhook signature');
    }

    return true;
  }
}
