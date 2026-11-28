import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { SellerTokenGuard } from './seller-token.guard.js';

describe('SellerTokenGuard', () => {
  const sha256Hex = (val: string) => createHash('sha256').update(val).digest('hex');

  const makeContext = (opts: {
    sellerId?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  }) => {
    const req: Record<string, unknown> = {
      params: opts.sellerId ? { sellerId: opts.sellerId } : {},
      headers: opts.headers ?? {},
      body: opts.body,
    };
    return {
      req,
      ctx: {
        switchToHttp: () => ({ getRequest: () => req }),
      } as never,
    };
  };

  it('rejects requests without sellerId or Bearer token', async () => {
    const prisma = { seller: { findUnique: vi.fn() }, device: { findFirst: vi.fn() } };
    const guard = new SellerTokenGuard(prisma as never);

    const missingAuth = makeContext({ sellerId: 's1', headers: {} });
    await expect(guard.canActivate(missingAuth.ctx)).rejects.toThrow(UnauthorizedException);

    const emptyToken = makeContext({ sellerId: 's1', headers: { authorization: 'Bearer   ' } });
    await expect(guard.canActivate(emptyToken.ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('authenticates against Seller.evidenceSecretHash when deviceId is omitted', async () => {
    const prisma = {
      seller: {
        findUnique: vi.fn().mockResolvedValue({
          id: 's1',
          evidenceSecretHash: sha256Hex('seller-secret-1'),
        }),
      },
      device: { findFirst: vi.fn() },
    };
    const guard = new SellerTokenGuard(prisma as never);

    const ok = makeContext({
      headers: { 'x-seller-id': 's1', authorization: 'Bearer seller-secret-1' },
    });
    expect(await guard.canActivate(ok.ctx)).toBe(true);
    expect(ok.req.sellerId).toBe('s1');

    const bad = makeContext({
      sellerId: 's1',
      headers: { authorization: 'Bearer wrong' },
    });
    await expect(guard.canActivate(bad.ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('requires Device.tokenHash when deviceId is provided and refuses seller secret fallback', async () => {
    const prisma = {
      seller: {
        findUnique: vi.fn().mockResolvedValue({
          id: 's1',
          evidenceSecretHash: sha256Hex('seller-secret-1'),
        }),
      },
      device: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: 'dev_1', tokenHash: sha256Hex('dev-secret-1') })
          .mockResolvedValueOnce({ id: 'dev_1', tokenHash: sha256Hex('dev-secret-1') })
          .mockResolvedValueOnce({ id: 'dev_2', tokenHash: null }),
      },
    };
    const guard = new SellerTokenGuard(prisma as never);

    const okDevice = makeContext({
      sellerId: 's1',
      headers: { authorization: 'Bearer dev-secret-1', 'x-device-id': 'dev_1' },
    });
    expect(await guard.canActivate(okDevice.ctx)).toBe(true);
    expect(okDevice.req.deviceId).toBe('dev_1');

    // Supplying seller secret instead of device secret must still be rejected
    const fallbackAttempt = makeContext({
      sellerId: 's1',
      headers: { authorization: 'Bearer seller-secret-1' },
      body: { deviceId: 'dev_1' },
    });
    await expect(guard.canActivate(fallbackAttempt.ctx)).rejects.toThrow(UnauthorizedException);

    // Null device tokenHash rejects
    const nullHash = makeContext({
      sellerId: 's1',
      headers: { authorization: 'Bearer anything', 'x-device-id': 'dev_2' },
    });
    await expect(guard.canActivate(nullHash.ctx)).rejects.toThrow(UnauthorizedException);
    expect(prisma.seller.findUnique).not.toHaveBeenCalled();
  });
});
