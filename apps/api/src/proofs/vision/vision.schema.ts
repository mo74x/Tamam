import { PaymentMethod } from '../../generated/prisma/client.js';
import { z } from 'zod';

export const VisionExtractionSchema = z.object({
  isPaymentReceipt: z.boolean(),
  isReadable: z.boolean(),
  receiptConfidence: z.number().min(0).max(1),
  amountEgp: z.string().nullable(),
  reference: z.string().nullable(),
  timestampLocal: z.string().nullable(), // Expected YYYY-MM-DD HH:mm (Egypt local time)
  senderName: z.string().nullable(),
  paymentMethod: z.nativeEnum(PaymentMethod),
  visualAnomalies: z.array(z.string()).max(5),
});

export type VisionExtractionResult = z.infer<typeof VisionExtractionSchema>;

// Plain JSON Schema compatible with both Gemini responseJsonSchema and OpenAI strict json_schema
export const VISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'isPaymentReceipt',
    'isReadable',
    'receiptConfidence',
    'amountEgp',
    'reference',
    'timestampLocal',
    'senderName',
    'paymentMethod',
    'visualAnomalies',
  ],
  properties: {
    isPaymentReceipt: { type: 'boolean' },
    isReadable: { type: 'boolean' },
    receiptConfidence: { type: 'number' },
    amountEgp: { type: ['string', 'null'] },
    reference: { type: ['string', 'null'] },
    timestampLocal: { type: ['string', 'null'] },
    senderName: { type: ['string', 'null'] },
    paymentMethod: {
      type: 'string',
      enum: [
        'INSTAPAY',
        'VODAFONE_CASH',
        'ETISALAT_CASH',
        'ORANGE_CASH',
        'WE_PAY',
        'BANK_TRANSFER',
        'UNKNOWN',
      ],
    },
    visualAnomalies: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

export const RECEIPT_EXTRACTION_PROMPT = [
  'You inspect WhatsApp images sent to Egyptian e-commerce sellers.',
  '1. Set isPaymentReceipt=false for product photos, clothing, chats, addresses, ID cards, or anything that is NOT a bank/wallet/InstaPay transfer confirmation.',
  '2. If isPaymentReceipt=true, extract the transfer amount in EGP as digits only (e.g. "650.00"), transaction reference/RRN, Egypt local timestamp as "YYYY-MM-DD HH:mm", sender name or @instapay handle, and paymentMethod.',
  '3. Set isReadable=false if the receipt is too blurry, cropped, or obstructed to read the amount.',
  '4. In visualAnomalies, list obvious tampering signs only if clearly visible (e.g. "mismatched_font", "overlaid_amount_box", "status_pending_or_failed"); otherwise return [].',
  'Never invent missing fields—return null instead.',
].join('\n');