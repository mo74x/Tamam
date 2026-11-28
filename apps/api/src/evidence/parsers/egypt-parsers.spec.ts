import { CibParser, InstaPayParser, NbeParser, VodafoneCashParser } from './egypt-parsers.js';
import { ParserRegistryService } from './parser-registry.service.js';

describe('Egyptian Bank & Wallet Parsers', () => {
  const mockLlm = { parse: vi.fn().mockResolvedValue(null) };
  const registry = new ParserRegistryService(mockLlm as never);
  const now = new Date('2026-11-26T09:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses Arabic Vodafone Cash incoming SMS with Arabic-Indic digits and ignores receiver phone', async () => {
    const sms =
      'تم استلام مبلغ ١٬٢٥٠٫٥٠ جنيه من رقم ٠١٠١٢٣٤٥٦٧٨ المسجل باسم محمد احمد على رقم محفظتك 01099999999. رصيدك الحالي: 5000 جنيه.';
    const res = await registry.parse('VF-Cash', sms, now);

    expect(res).toMatchObject({
      amountPiasters: 125050n,
      parserName: 'vf_cash_v1',
      sender: 'محمد احمد 01012345678',
      time: null,
    });
    expect(mockLlm.parse).not.toHaveBeenCalled();
  });

  it('parses English Vodafone Cash SMS with ref and embedded timestamp', () => {
    const parser = new VodafoneCashParser();
    const res = parser.parse(
      'You have received EGP 750.00 from 01055554444 on 26/11/2026 11:30 AM Ref: VFC998877',
      now,
    );
    expect(res).toMatchObject({
      amountPiasters: 75000n,
      ref: 'VFC998877',
      sender: '01055554444',
      parserName: 'vf_cash_v1',
    });
    expect(res?.time?.toISOString()).toBe('2026-11-26T09:30:00.000Z');
    expect(parser.parse('Debit EGP 100', now)).toBeNull();
  });

  it('parses InstaPay incoming transfer with IPA handle, sender-clause phone, and reference', async () => {
    const notif =
      'InstaPay: You received EGP 650.00 from sara.ali@instapay 01012345678 on your account 01099998888 Ref: IPN2611998877';
    const res = await registry.parse('com.egyptianbanks.instapay', notif, now);

    expect(res).toMatchObject({
      amountPiasters: 65000n,
      ref: 'IPN2611998877',
      sender: 'sara.ali@instapay 01012345678',
      parserName: 'instapay_notif_v1',
      time: null,
    });
  });

  it('parses InstaPay without ref and rejects non-credit InstaPay alerts', () => {
    const parser = new InstaPayParser();
    expect(parser.parse('InstaPay OTP is 123456', now)).toBeNull();
    expect(parser.parse('You received EGP 0 from bob@instapay', now)).toBeNull();

    const noRef = parser.parse('تم استلام مبلغ 300 جنيه من ahmed.nabil@instapay', now);
    expect(noRef).toMatchObject({
      amountPiasters: 30000n,
      ref: null,
      sender: 'ahmed.nabil@instapay',
      confidence: 0.94,
    });
    expect(parser.parse('You received 200 EGP Ref: IPN11223344', now)).toMatchObject({
      amountPiasters: 20000n,
      sender: null,
    });
  });

  it('parses CIB credit SMS and ignores outgoing debits', async () => {
    const credit = 'CIB: Your account ****1234 has been credited with EGP 2,400.00 from Nada Ali Ref: FT26330123';
    const res = await registry.parse('CIB', credit, now);
    expect(res?.amountPiasters).toBe(240000n);
    expect(res?.ref).toBe('FT26330123');
    expect(res?.sender).toBe('nada ali');

    const cib = new CibParser();
    expect(cib.supports(null)).toBe(false);
    expect(cib.parse('CIB: Card purchase of EGP 500 at Noon', now)).toBeNull();
    expect(cib.parse('تم إضافة مبلغ 0 جنيه لحسابك', now)).toBeNull();
  });

  it('parses Arabic & English NBE credit SMS and rejects NBE debits', async () => {
    const arNbe = 'البنك الأهلي المصري: تم إضافة مبلغ 1,500.25 جنيه من كريم حسن رقم مرجعي NBE77889900';
    const res = await registry.parse('NBE', arNbe, now);
    expect(res).toMatchObject({
      amountPiasters: 150025n,
      ref: 'NBE77889900',
      sender: 'كريم حسن',
      parserName: 'nbe_sms_v1',
      time: null,
    });

    const nbe = new NbeParser();
    expect(nbe.supports(null)).toBe(false);
    expect(nbe.supports('com.nbe.mobile')).toBe(true);
    expect(nbe.supports('AlAhly')).toBe(true);
    expect(nbe.parse('تم خصم مبلغ 500 جنيه من حسابك', now)).toBeNull();
    expect(nbe.parse('credited with EGP 0', now)).toBeNull();
  });

  it('enforces senderApp allowlists unless allowUnscopedFallback is true and forwards sellerId to LLM', async () => {
    const spoofedText = 'InstaPay: You received EGP 650.00 from sara.ali@instapay Ref: IPN999888';

    await registry.parse('com.fake.whatsapp', spoofedText, now, { sellerId: 'seller_1' });
    expect(mockLlm.parse).toHaveBeenCalledWith(spoofedText, now, {
      sellerId: 'seller_1',
      senderApp: 'com.fake.whatsapp',
    });

    // When allowlisted app fails regex match, falls through cleanly to LLM
    vi.clearAllMocks();
    await registry.parse('VF-Cash', 'VF-Cash maintenance notice', now, { sellerId: 'seller_1' });
    expect(mockLlm.parse).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const manual = await registry.parse(null, spoofedText, now, {
      allowUnscopedFallback: true,
      sellerId: 'seller_1',
    });
    expect(manual).toMatchObject({
      amountPiasters: 65000n,
      ref: 'IPN999888',
      parserName: 'instapay_notif_v1',
    });
    expect(mockLlm.parse).not.toHaveBeenCalled();

    // Unscoped fallback that matches no parser still falls back to LLM
    await registry.parse(null, 'Random unrelated message', now, { allowUnscopedFallback: true });
    expect(mockLlm.parse).toHaveBeenCalledTimes(1);
  });
});
