import { RedisModule } from '../redis/redis.module.js';
import { RedisLockService } from './redis-lock.service.js';

describe('RedisLockService', () => {
  it('acquires a lock when key is free and releases only with matching token', async () => {
    const store = new Map<string, string>();
    const mockRedis = {
      set: vi.fn(async (key: string, val: string, _px: string, _ttl: number, nx: string) => {
        if (nx === 'NX' && store.has(key)) return null;
        store.set(key, val);
        return 'OK';
      }),
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
        if (store.get(key) === token) {
          store.delete(key);
          return 1;
        }
        return 0;
      }),
      quit: vi.fn().mockResolvedValue('OK'),
    };

    const lock = new RedisLockService(mockRedis as never);
    const token = await lock.acquire('lock:seller:s1', 5_000);
    expect(token).toBeTruthy();
    expect(mockRedis.set).toHaveBeenCalledWith('lock:seller:s1', token, 'PX', 5_000, 'NX');

    // Second concurrent acquire fails while held
    const contested = await lock.acquire('lock:seller:s1');
    expect(contested).toBeNull();

    // Release with wrong token leaves key intact
    await lock.release('lock:seller:s1', 'wrong-token');
    expect(store.get('lock:seller:s1')).toBe(token);

    // Release with matching token deletes key
    await lock.release('lock:seller:s1', token!);
    expect(store.has('lock:seller:s1')).toBe(false);
  });

  it('closes REDIS_CLIENT cleanly on RedisModule.onModuleDestroy', async () => {
    const mockRedis = { quit: vi.fn().mockResolvedValue('OK') };
    const redisModule = new RedisModule(mockRedis as never);

    await redisModule.onModuleDestroy();

    expect(mockRedis.quit).toHaveBeenCalledTimes(1);
  });
});
