import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import { WhatsAppApiClient, WhatsAppApiError } from '../channels/whatsapp/whatsapp-api.client.js';
import { CryptoService } from '../common/crypto.service.js';
import { ChannelType, ProofStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  formatEgp,
  REASON_LABELS_AR,
  resolveTemplate,
  SellerReplyTemplates,
} from './templates.js';

type ReplyJobData =
  | { sellerId: string; customerPhone: string; proofId: string }
  | { sellerId: string; ownerPhone: string; proofId: string; status: string; reasonCode: string }
  | { sellerId: string; ownerPhone: string; deviceLabel: string }
  | { sellerId: string; recipientPhone: string; proofId: string; message: string }
  | { senderPhone: string; sellerCount: number }
  | { sellerId: string; ownerPhone: string; monthKey: string; limit: number };

const CUSTOMER_JOB_TO_TEMPLATE: Record<string, keyof SellerReplyTemplates> = {
  'customer-waiting': 'waiting',
  'customer-confirmed': 'confirmed',
  'customer-waiting-longer': 'waitingLonger',
  'customer-suspicious': 'suspicious',
  'customer-unreadable': 'unreadable',
};

const WHATSAPP_WINDOW_MS = 23.5 * 3600_000;

@Processor('replies', { concurrency: 10 })
export class RepliesProcessor extends WorkerHost {
  private readonly logger = new Logger(RepliesProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly whatsapp: WhatsAppApiClient,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {
    super();
  }

  private get alertPhoneNumberId(): string {
    return process.env.TAMAM_ALERT_PHONE_NUMBER_ID ?? '';
  }

  private get alertAccessToken(): string {
    return process.env.TAMAM_ALERT_ACCESS_TOKEN ?? '';
  }

  async process(job: Job<ReplyJobData>): Promise<void> {
    try {
      if (job.name in CUSTOMER_JOB_TO_TEMPLATE) {
        await this.sendCustomerReply(
          job.name,
          job.data as { sellerId: string; customerPhone: string; proofId: string },
        );
        return;
      }

      if (job.name === 'owner-alert') {
        await this.sendOwnerProofAlert(
          job.data as {
            sellerId: string;
            ownerPhone: string;
            proofId: string;
            status: string;
            reasonCode: string;
          },
        );
        return;
      }

      if (job.name === 'owner-device-offline') {
        await this.sendOwnerDeviceOfflineAlert(
          job.data as { sellerId: string; ownerPhone: string; deviceLabel: string },
        );
        return;
      }

      if (job.name === 'owner-action-feedback') {
        const d = job.data as { recipientPhone: string; message: string };
        await this.sendAlertTextIfConfigured(d.recipientPhone, d.message);
        return;
      }

      if (job.name === 'forwarder-ambiguous-seller') {
        const d = job.data as { senderPhone: string; sellerCount: number };
        await this.sendAlertTextIfConfigured(
          d.senderPhone,
          `حسابك مربوط بـ ${d.sellerCount} متاجر على تمام. من فضلك ارفع الإيصال من لوحة التحكم (/proofs).`,
        );
        return;
      }

      if (job.name === 'owner-quota-exceeded') {
        const d = job.data as { ownerPhone: string; monthKey: string; limit: number };
        await this.sendAlertTextIfConfigured(
          d.ownerPhone,
          `تنبيه: وصلت للحد الشهري للخطة (${d.limit} إيصال لشهر ${d.monthKey}). يمكنك الترقية من لوحة التحكم.`,
        );
      }
    } catch (err) {
      if (err instanceof WhatsAppApiError && !err.retryable) {
        this.logger.warn(`Non-retryable WhatsApp error (${err.metaCode}): ${err.message}`);
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  private async sendCustomerReply(
    jobName: string,
    data: { sellerId: string; customerPhone: string; proofId: string },
  ): Promise<void> {
    const proof = await this.prisma.proof.findUnique({
      where: { id: data.proofId },
      include: {
        channel: { select: { id: true, type: true, phoneNumberId: true, encryptedToken: true } },
        seller: {
          select: {
            ownerPhone: true,
            replyTemplates: true,
            channels: { where: { isActive: true }, take: 1 },
          },
        },
      },
    });
    if (!proof) return;
    if (proof.statusReason === 'TEST_ROUNDTRIP') return;

    if (jobName === 'customer-waiting') {
      if (proof.status !== ProofStatus.WAITING || proof.waitingReplySent) return;
    }

    const recipientPhone = proof.replyToPhone ?? data.customerPhone;
    const withinWindow = Date.now() - proof.createdAt.getTime() <= WHATSAPP_WINDOW_MS;

    // Staff-forwarded receipts reply via Tamam's alert number (or fall back to template past 23.5h)
    if (proof.isForwarded) {
      if (!this.alertPhoneNumberId || !this.alertAccessToken) return;
      if (withinWindow) {
        const templateKey = CUSTOMER_JOB_TO_TEMPLATE[jobName];
        const body = resolveTemplate(proof.seller.replyTemplates, templateKey);
        await this.whatsapp.sendTextMessage({
          phoneNumberId: this.alertPhoneNumberId,
          accessToken: this.alertAccessToken,
          to: recipientPhone,
          body,
          replyToWamid: proof.channelMessageId,
        });
      } else {
        await this.whatsapp.sendUtilityTemplate({
          phoneNumberId: this.alertPhoneNumberId,
          accessToken: this.alertAccessToken,
          to: proof.seller.ownerPhone,
          templateName: 'tamam_owner_review_v1',
          languageCode: 'ar_EG',
          bodyParams: [formatEgp(proof.extractedAmountPiasters), recipientPhone, 'تحديث حالة الإيصال'],
        });
      }
      return;
    }

    // Coexistence manual reply suppression (15m echo cache)
    if (this.redis) {
      const echoed = await this.redis.exists(`coexistence:echo:${data.sellerId}:${recipientPhone}`);
      if (echoed) return;
    }

    const channel = proof.channel ?? proof.seller.channels[0];
    if (!channel || !channel.phoneNumberId || !channel.encryptedToken) return;

    if (
      (channel.type === ChannelType.WHATSAPP_DEDICATED ||
        channel.type === ChannelType.WHATSAPP_COEXISTENCE) &&
      !withinWindow
    ) {
      await this.prisma.auditLog.create({
        data: {
          sellerId: data.sellerId,
          entityType: 'PROOF',
          entityId: proof.id,
          action: 'CUSTOMER_WINDOW_EXPIRED',
          actorType: 'SYSTEM',
          payload: { recipientPhone, jobName },
        },
      });
      await this.sendOwnerProofAlert({
        sellerId: data.sellerId,
        ownerPhone: proof.seller.ownerPhone,
        proofId: proof.id,
        status: proof.status,
        reasonCode: 'CUSTOMER_WINDOW_EXPIRED',
      });
      return;
    }

    const templateKey = CUSTOMER_JOB_TO_TEMPLATE[jobName];
    const body = resolveTemplate(proof.seller.replyTemplates, templateKey);
    const accessToken = this.crypto.decrypt(channel.encryptedToken);

    await this.whatsapp.sendTextMessage({
      phoneNumberId: channel.phoneNumberId,
      accessToken,
      to: recipientPhone,
      body,
      replyToWamid: proof.channelMessageId,
    });

    if (jobName === 'customer-waiting') {
      await this.prisma.proof.update({
        where: { id: proof.id },
        data: { waitingReplySent: true },
      });
    }
  }

  private async sendOwnerProofAlert(data: {
    sellerId: string;
    ownerPhone: string;
    proofId: string;
    status: string;
    reasonCode: string;
  }): Promise<void> {
    if (!this.alertPhoneNumberId || !this.alertAccessToken) {
      this.logger.warn('Tamam alert WhatsApp credentials not configured; skipping owner alert');
      return;
    }

    // Never suppress SUSPICIOUS; suppress UNMATCHED alerts when device is offline or in 900s cooldown
    if (data.status === ProofStatus.UNMATCHED) {
      const offlineDevice = await this.prisma.device.findFirst({
        where: { sellerId: data.sellerId, offlineAlerted: true },
        select: { id: true },
      });
      if (offlineDevice !== null) return;

      if (this.redis) {
        const cooled = await this.redis.set(
          `alert:unmatched-cooldown:${data.sellerId}`,
          '1',
          'EX',
          900,
          'NX',
        );
        if (!cooled) return;
      }
    }

    const proof = await this.prisma.proof.findUnique({
      where: { id: data.proofId },
      include: { customer: { select: { phone: true, displayName: true } } },
    });
    if (!proof) return;

    const customerLabel = proof.customer
      ? proof.customer.displayName
        ? `${proof.customer.displayName} (${proof.customer.phone})`
        : proof.customer.phone
      : (proof.replyToPhone ?? 'محوّل من المالك');
    const amountLabel = formatEgp(proof.extractedAmountPiasters);
    const reasonAr = REASON_LABELS_AR[data.reasonCode] ?? data.reasonCode;

    const hasOwnerWindow = this.redis
      ? Boolean(await this.redis.exists(`alert:owner-window:${data.ownerPhone}`))
      : false;

    if (hasOwnerWindow) {
      await this.whatsapp.sendTextMessage({
        phoneNumberId: this.alertPhoneNumberId,
        accessToken: this.alertAccessToken,
        to: data.ownerPhone,
        body: `مراجعة إيصال (${amountLabel}) — ${customerLabel}: ${reasonAr}`,
      });
      return;
    }

    const buttons =
      data.reasonCode === 'AMBIGUOUS_MULTIPLE_EVIDENCE'
        ? [{ index: 1, payload: `REJECT:${proof.id}` }]
        : [
            { index: 0, payload: `CONFIRM:${proof.id}` },
            { index: 1, payload: `REJECT:${proof.id}` },
          ];

    await this.whatsapp.sendUtilityTemplate({
      phoneNumberId: this.alertPhoneNumberId,
      accessToken: this.alertAccessToken,
      to: data.ownerPhone,
      templateName: 'tamam_owner_review_v1',
      languageCode: 'ar_EG',
      bodyParams: [amountLabel, customerLabel, reasonAr],
      quickReplyButtons: buttons,
    });
  }

  private async sendOwnerDeviceOfflineAlert(data: {
    sellerId: string;
    ownerPhone: string;
    deviceLabel: string;
  }): Promise<void> {
    if (!this.alertPhoneNumberId || !this.alertAccessToken) return;

    const hasOwnerWindow = this.redis
      ? Boolean(await this.redis.exists(`alert:owner-window:${data.ownerPhone}`))
      : false;

    if (hasOwnerWindow) {
      await this.whatsapp.sendTextMessage({
        phoneNumberId: this.alertPhoneNumberId,
        accessToken: this.alertAccessToken,
        to: data.ownerPhone,
        body: `تنبيه: جهاز استقبال الإشعارات "${data.deviceLabel}" غير متصل منذ 45 دقيقة.`,
      });
      return;
    }

    await this.whatsapp.sendUtilityTemplate({
      phoneNumberId: this.alertPhoneNumberId,
      accessToken: this.alertAccessToken,
      to: data.ownerPhone,
      templateName: 'tamam_device_offline_v1',
      languageCode: 'ar_EG',
      bodyParams: [data.deviceLabel],
    });
  }

  private async sendAlertTextIfConfigured(to: string, body: string): Promise<void> {
    if (!this.alertPhoneNumberId || !this.alertAccessToken) return;
    await this.whatsapp.sendTextMessage({
      phoneNumberId: this.alertPhoneNumberId,
      accessToken: this.alertAccessToken,
      to,
      body,
    });
  }
}
