import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ProofStatus } from '../generated/prisma/client.js';
import { Job, UnrecoverableError } from 'bullmq';
import { CryptoService } from '../common/crypto.service.js';
import { WhatsAppApiClient, WhatsAppApiError } from '../channels/whatsapp/whatsapp-api.client.js';
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
  | { sellerId: string; ownerPhone: string; deviceLabel: string };

const CUSTOMER_JOB_TO_TEMPLATE: Record<string, keyof SellerReplyTemplates> = {
  'customer-waiting': 'waiting',
  'customer-confirmed': 'confirmed',
  'customer-waiting-longer': 'waitingLonger',
  'customer-suspicious': 'suspicious',
  'customer-unreadable': 'unreadable',
};

@Processor('replies', { concurrency: 10 })
export class RepliesProcessor extends WorkerHost {
  private readonly logger = new Logger(RepliesProcessor.name);
  private readonly alertPhoneNumberId = process.env.TAMAM_ALERT_PHONE_NUMBER_ID ?? '';
  private readonly alertAccessToken = process.env.TAMAM_ALERT_ACCESS_TOKEN ?? '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly whatsapp: WhatsAppApiClient,
  ) {
    super();
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
        seller: {
          select: {
            replyTemplates: true,
            channels: { where: { isActive: true }, take: 1 },
          },
        },
      },
    });
    if (!proof) return;

    // Race guard for the 20s debounced WAITING reply:
    // If evidence arrived and confirmed the proof just before pickup, skip sending WAITING.
    if (jobName === 'customer-waiting') {
      if (proof.status !== ProofStatus.WAITING || proof.waitingReplySent) return;
    }

    const channel = proof.seller.channels[0];
    if (!channel || !channel.phoneNumberId || !channel.encryptedToken) return;

    const templateKey = CUSTOMER_JOB_TO_TEMPLATE[jobName];
    const body = resolveTemplate(proof.seller.replyTemplates, templateKey);
    const accessToken = this.crypto.decrypt(channel.encryptedToken);

    await this.whatsapp.sendTextMessage({
      phoneNumberId: channel.phoneNumberId,
      accessToken,
      to: data.customerPhone,
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

    // Strictly transactional UTILITY template with one-tap Confirm / Reject buttons
    await this.whatsapp.sendUtilityTemplate({
      phoneNumberId: this.alertPhoneNumberId,
      accessToken: this.alertAccessToken,
      to: data.ownerPhone,
      templateName: 'tamam_owner_review_v1',
      languageCode: 'ar_EG',
      bodyParams: [amountLabel, customerLabel, reasonAr],
      quickReplyButtons: [
        { index: 0, payload: `CONFIRM:${proof.id}` },
        { index: 1, payload: `REJECT:${proof.id}` },
      ],
    });
  }

  private async sendOwnerDeviceOfflineAlert(data: {
    sellerId: string;
    ownerPhone: string;
    deviceLabel: string;
  }): Promise<void> {
    if (!this.alertPhoneNumberId || !this.alertAccessToken) return;

    await this.whatsapp.sendUtilityTemplate({
      phoneNumberId: this.alertPhoneNumberId,
      accessToken: this.alertAccessToken,
      to: data.ownerPhone,
      templateName: 'tamam_device_offline_v1',
      languageCode: 'ar_EG',
      bodyParams: [data.deviceLabel],
    });
  }
}