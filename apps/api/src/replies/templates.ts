export interface SellerReplyTemplates {
  waiting: string;
  confirmed: string;
  waitingLonger: string;
  suspicious: string;
  unreadable: string;
}

export const DEFAULT_AR_TEMPLATES: SellerReplyTemplates = {
  waiting: 'استلمنا الإيصال ✅ بنتأكد من وصول المبلغ، هنرد عليك خلال دقايق.',
  confirmed: 'تمام ✅ المبلغ وصل وطلبك اتأكد، جاري التجهيز. شكراً ليك!',
  waitingLonger: 'لسه المبلغ ماوصلش، ممكن التحويل يتأخر شوية. هنتابع معاك ونرد عليك.',
  suspicious: 'استلمنا الصورة، بنراجع الإيصال يدوي وصاحب المحل هيتواصل معاك قريب.',
  unreadable: 'الصورة مش واضحة، ممكن تبعت لقطة شاشة واضحة من التطبيق فيها المبلغ والرقم المرجعي؟',
};

export const REASON_LABELS_AR: Record<string, string> = {
  DUPLICATE_REF: 'الرقم المرجعي مستخدم قبل كده',
  DUPLICATE_IMAGE_EXACT: 'نفس صورة الإيصال مبعوتة قبل كده',
  DUPLICATE_IMAGE_PHASH: 'صورة إيصال مكررة أو مقصوصة',
  AMBIGUOUS_MULTIPLE_EVIDENCE: 'فيه أكتر من تحويل بنفس المبلغ في نفس الوقت',
  AMOUNT_FEE_MISMATCH: 'فرق بسيط في المبلغ بين الإيصال والتحويل',
  VISUAL_TAMPER_WARNING: 'مؤشر تعديل على صورة الإيصال',
  REF_MISMATCH: 'الرقم المرجعي مختلف عن إشعار البنك',
  EVIDENCE_TIMEOUT: 'انتهت مهلة الانتظار ولم يصل إشعار تحويل',
};

export function resolveTemplate(
  overrides: unknown,
  key: keyof SellerReplyTemplates,
): string {
  const custom = (overrides as Partial<SellerReplyTemplates> | null)?.[key];
  return typeof custom === 'string' && custom.trim().length > 0
    ? custom.trim()
    : DEFAULT_AR_TEMPLATES[key];
}

export function formatEgp(piasters?: bigint | null): string {
  if (!piasters) return 'غير محدد';
  const whole = piasters / 100n;
  const frac = (piasters % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${frac} جنيه`;
}