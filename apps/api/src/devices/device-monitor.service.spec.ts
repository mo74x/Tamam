import { DeviceMonitorService } from './device-monitor.service.js';

describe('DeviceMonitorService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips checks before 09:00 Africa/Cairo time', async () => {
    vi.useFakeTimers();
    // 06:30 UTC = 08:30 Cairo (EET UTC+2 in November)
    vi.setSystemTime(new Date('2026-11-26T06:30:00.000Z'));

    const prisma = { device: { findMany: vi.fn() } };
    const redis = { set: vi.fn() };
    const repliesQueue = { add: vi.fn() };

    const service = new DeviceMonitorService(prisma as never, redis as never, repliesQueue as never);
    await service.checkStaleDevices();

    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.device.findMany).not.toHaveBeenCalled();
  });

  it('respects 240s Redis NX cooldown lock across replicas', async () => {
    vi.useFakeTimers();
    // 10:00 UTC = 12:00 Cairo
    vi.setSystemTime(new Date('2026-11-26T10:00:00.000Z'));

    const prisma = { device: { findMany: vi.fn() } };
    const redis = { set: vi.fn().mockResolvedValue(null) };
    const repliesQueue = { add: vi.fn() };

    const service = new DeviceMonitorService(prisma as never, redis as never, repliesQueue as never);
    await service.checkStaleDevices();

    expect(redis.set).toHaveBeenCalledWith('lock:cron:device-monitor', '1', 'PX', 240_000, 'NX');
    expect(prisma.device.findMany).not.toHaveBeenCalled();
  });

  it('flags stale devices, writes AuditLog, and enqueues owner-device-offline alerts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T10:00:00.000Z'));

    const lastBeat = new Date('2026-11-26T08:00:00.000Z');
    const prisma = {
      device: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'dev_1',
            sellerId: 'seller_1',
            deviceLabel: 'Samsung A55',
            lastHeartbeatAt: lastBeat,
            seller: { id: 'seller_1', ownerPhone: '+201099999999', businessName: 'Store' },
          },
        ]),
        update: vi.fn().mockResolvedValue({ id: 'dev_1' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'log_1' }) },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const redis = { set: vi.fn().mockResolvedValue('OK') };
    const repliesQueue = { add: vi.fn().mockResolvedValue({ id: 'job_1' }) };

    const service = new DeviceMonitorService(prisma as never, redis as never, repliesQueue as never);
    await service.checkStaleDevices();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'dev_1' },
      data: { offlineAlerted: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 'dev_1',
        action: 'DEVICE_OFFLINE_ALERTED',
      }),
    });
    expect(repliesQueue.add).toHaveBeenCalledWith('owner-device-offline', {
      sellerId: 'seller_1',
      ownerPhone: '+201099999999',
      deviceLabel: 'Samsung A55',
    });
  });
});
