import { CryptoModule } from './crypto.module.js';
import { CryptoService } from './crypto.service.js';

describe('CryptoService', () => {
  const validHexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = originalKey;
    }
  });

  it('rejects missing or invalid TOKEN_ENCRYPTION_KEY lengths/characters', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => new CryptoService()).toThrow(/64-character hex/);

    process.env.TOKEN_ENCRYPTION_KEY = 'zzzz';
    expect(() => new CryptoService()).toThrow(/64-character hex/);
  });

  it('encrypts and decrypts UTF-8 tokens with unique random IVs per call', () => {
    process.env.TOKEN_ENCRYPTION_KEY = validHexKey;
    const crypto = new CryptoService();

    const secret = 'EAAGm0PX4ZCpsBA...تمام';
    const c1 = crypto.encrypt(secret);
    const c2 = crypto.encrypt(secret);

    expect(c1).not.toBe(c2);
    expect(c1.split('.')).toHaveLength(3);
    expect(crypto.decrypt(c1)).toBe(secret);
    expect(crypto.decrypt(c2)).toBe(secret);
  });

  it('rejects malformed payloads, wrong IV/tag lengths, and tampered auth tags', () => {
    process.env.TOKEN_ENCRYPTION_KEY = validHexKey;
    const crypto = new CryptoService();

    expect(() => crypto.decrypt('only.two')).toThrow(/Invalid encrypted token format/);

    const valid = crypto.encrypt('hello');
    const [ivB64, tagB64, dataB64] = valid.split('.');

    const badIv = `${Buffer.from('short').toString('base64')}.${tagB64}.${dataB64}`;
    expect(() => crypto.decrypt(badIv)).toThrow(/Invalid encrypted token header/);

    const badTag = `${ivB64}.${Buffer.from('short').toString('base64')}.${dataB64}`;
    expect(() => crypto.decrypt(badTag)).toThrow(/Invalid encrypted token header/);

    const tamperedTagBytes = Buffer.from(tagB64, 'base64');
    tamperedTagBytes[0] ^= 0xff;
    const tampered = `${ivB64}.${tamperedTagBytes.toString('base64')}.${dataB64}`;
    expect(() => crypto.decrypt(tampered)).toThrow();
  });

  it('is registered cleanly by CryptoModule', () => {
    expect(CryptoModule).toBeDefined();
  });
});
