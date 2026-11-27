const SENSITIVE_OR_SCAM_PATTERNS: RegExp[] = [
  /\b(otp|one[\s-]?time\s+pass(word|code)?|verification\s+code|pin\s+code|cvv|3ds)\b/i,
  /(رمز\s*التحقق|كود\s*التفعيل|كود\s*التأكيد|كلمة\s*السر|الرقم\s*السري|لا\s*تشارك)/,
  /(بالخطأ|عن\s*طريق\s*الخطأ|ارجو\s*اعادته|برجاء\s*إعادته)/, // Common VF-Cash/InstaPay spoof text
];

const OUTGOING_ONLY_PATTERNS: RegExp[] = [
  /^(تم\s*(تحويل|سحب|خصم|دفع)\s*مبلغ)/,
  /\b(debited|withdrawn|purchase\s+at|you\s+have\s+sent|transfer\s+to)\b/i,
];

export function classifyNoise(rawText: string): 'OTP_OR_SCAM' | 'OUTGOING' | 'OK' {
  const text = rawText.trim();
  if (SENSITIVE_OR_SCAM_PATTERNS.some((re) => re.test(text))) {
    return 'OTP_OR_SCAM';
  }
  if (OUTGOING_ONLY_PATTERNS.some((re) => re.test(text))) {
    return 'OUTGOING';
  }
  return 'OK';
}