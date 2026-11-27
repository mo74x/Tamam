import { ParserRegistryService } from './parser-registry.service.js';

describe('Egyptian Bank & Wallet Parsers', () => {
  const mockLlm = { parse: vi.fn().mockResolvedValue(null) };
  const registry = new ParserRegistryService(mockLlm as any);
  const now = new Date('2026-11-26T09:00:00.000Z');

  it('parses Arabic Vodafone Cash incoming SMS with Arabic-Indic digits', async () => {
    const sms =
      'تم استلام مبلغ ١٬٢٥٠٫٥٠ جنيه من رقم ٠١٠١٢٣٤٥٦٧٨ المسجل باسم محمد احمد على رقم محفظتك 01099999999. رصيدك الحالي: 5000 جنيه.';
    const res = await registry.parse('VF-Cash', sms, now);

    expect(res).toMatchObject({
      amountPiasters: 125050n,
      parserName: 'vf_cash_v1',
      sender: 'محمد احمد 01012345678',
    });
    expect(mockLlm.parse).not.toHaveBeenCalled();
  });

  it('parses InstaPay incoming transfer with IPA handle and reference', async () => {
    const notif =
      'InstaPay: You received EGP 650.00 from sara.ali@instapay Ref: IPN2611998877';
    const res = await registry.parse('com.egyptianbanks.instapay', notif, now);

    expect(res).toMatchObject({
      amountPiasters: 65000n,
      ref: 'IPN2611998877',
      sender: 'sara.ali@instapay',
      parserName: 'instapay_notif_v1',
    });
  });

  it('parses CIB credit SMS and ignores outgoing debits', async () => {
    const credit = 'CIB: Your account ****1234 has been credited with EGP 2,400.00 Ref: FT26330123';
    const res = await registry.parse('CIB', credit, now);
    expect(res?.amountPiasters).toBe(240000n);
    expect(res?.ref).toBe('FT26330123');
  });
});