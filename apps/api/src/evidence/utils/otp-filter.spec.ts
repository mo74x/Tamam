import { classifyNoise } from './otp-filter.js';

describe('classifyNoise', () => {
  it('blocks OTP codes and social-engineering refund scam messages', () => {
    expect(classifyNoise('Your one-time password is 482910')).toBe('OTP_OR_SCAM');
    expect(classifyNoise('كود التحقق الخاص بك هو 884422 لا تشاركه')).toBe('OTP_OR_SCAM');
    expect(classifyNoise('تم التحويل عن طريق الخطأ برجاء إعادته')).toBe('OTP_OR_SCAM');
  });

  it('blocks outgoing debit notifications', () => {
    expect(classifyNoise('تم تحويل مبلغ 500 جنيه إلى 01012345678')).toBe('OUTGOING');
    expect(classifyNoise('Your card was debited EGP 350.00 at Noon')).toBe('OUTGOING');
  });

  it('allows legitimate incoming payment notifications', () => {
    expect(classifyNoise('تم استلام مبلغ 650 جنيه من رقم 01012345678')).toBe('OK');
    expect(classifyNoise('InstaPay: You received EGP 650.00 from sara@instapay')).toBe('OK');
  });
});
