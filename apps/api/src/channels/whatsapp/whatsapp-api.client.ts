import { Injectable } from '@nestjs/common';

const GRAPH_BASE = 'https://graph.facebook.com/v26.0';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // 10 MB safety cap

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly metaCode?: number,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export interface QuickReplyButtonParam {
  index: number;
  payload: string;
}

@Injectable()
export class WhatsAppApiClient {
  async sendTextMessage(params: {
    phoneNumberId: string;
    accessToken: string;
    to: string;
    body: string;
    replyToWamid?: string;
  }): Promise<string> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to.replace(/^\+/, ''),
      type: 'text',
      text: { preview_url: false, body: params.body },
    };

    if (params.replyToWamid) {
      payload.context = { message_id: params.replyToWamid };
    }

    const res = await this.postMessage(params.phoneNumberId, params.accessToken, payload);
    return res.messages?.[0]?.id ?? '';
  }

  async sendUtilityTemplate(params: {
    phoneNumberId: string;
    accessToken: string;
    to: string;
    templateName: string;
    languageCode?: string;
    bodyParams: string[];
    quickReplyButtons?: QuickReplyButtonParam[];
  }): Promise<string> {
    const components: Array<Record<string, unknown>> = [];

    if (params.bodyParams.length > 0) {
      components.push({
        type: 'body',
        parameters: params.bodyParams.map((text) => ({ type: 'text', text })),
      });
    }

    for (const btn of params.quickReplyButtons ?? []) {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(btn.index),
        parameters: [{ type: 'payload', payload: btn.payload }],
      });
    }

    const res = await this.postMessage(params.phoneNumberId, params.accessToken, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: params.templateName,
        language: { code: params.languageCode ?? 'ar_EG' },
        components,
      },
    });

    return res.messages?.[0]?.id ?? '';
  }

  async downloadMedia(params: {
    accessToken: string;
    mediaId: string;
    directUrl?: string;
  }): Promise<{ buffer: Buffer; mimeType: string }> {
    const headers = { Authorization: `Bearer ${params.accessToken}` };

    const fetchBinary = async (url: string) => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { ok: false as const, status: res.status };

      const contentLength = Number(res.headers.get('content-length') ?? '0');
      if (contentLength > MAX_RECEIPT_BYTES) {
        throw new WhatsAppApiError('Receipt media exceeds 10MB limit', 413, undefined, false);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_RECEIPT_BYTES) {
        throw new WhatsAppApiError('Receipt media exceeds 10MB limit', 413, undefined, false);
      }

      return {
        ok: true as const,
        buffer: buf,
        mimeType: res.headers.get('content-type') ?? 'image/jpeg',
      };
    };

    // Use webhook shortcut URL if present; fall back to fresh lookup on 404/410
    if (params.directUrl) {
      const attempt = await fetchBinary(params.directUrl);
      if (attempt.ok) return { buffer: attempt.buffer, mimeType: attempt.mimeType };
    }

    const metaRes = await fetch(`${GRAPH_BASE}/${encodeURIComponent(params.mediaId)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!metaRes.ok) {
      throw new WhatsAppApiError(
        `Failed to fetch media URL (${metaRes.status})`,
        metaRes.status,
        undefined,
        metaRes.status >= 500 || metaRes.status === 429,
      );
    }

    const metaJson = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!metaJson.url) {
      throw new WhatsAppApiError('Meta media response missing url', 502, undefined, true);
    }

    const fileRes = await fetchBinary(metaJson.url);
    if (!fileRes.ok) {
      throw new WhatsAppApiError(
        `Media binary download failed (${fileRes.status})`,
        fileRes.status,
        undefined,
        fileRes.status >= 500 || fileRes.status === 429,
      );
    }

    return {
      buffer: fileRes.buffer,
      mimeType: metaJson.mime_type ?? fileRes.mimeType,
    };
  }

  private async postMessage(
    phoneNumberId: string,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<{ messages?: Array<{ id: string }> }> {
    const res = await fetch(`${GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    const body = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number };
    };

    if (!res.ok) {
      const code = body.error?.code;
      // 130429 = throughput rate limit; 5xx = transient Meta outage; 131047 = outside 24h window
      const retryable = res.status >= 500 || res.status === 429 || code === 130429;
      throw new WhatsAppApiError(
        body.error?.message ?? `WhatsApp API error ${res.status}`,
        res.status,
        code,
        retryable,
      );
    }

    return body;
  }
}