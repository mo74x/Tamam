import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

export type AiProviderName = 'gemini' | 'openai';

export interface AiVisionParams {
  imageBuffer: Buffer;
  mimeType: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  schemaName?: string;
  timeoutMs?: number;
}

export interface AiJsonParams {
  systemPrompt: string;
  userText: string;
  timeoutMs?: number;
}

export interface AiCallResult {
  provider: AiProviderName;
  model: string;
  latencyMs: number;
  estimatedCostMicroUsd: number;
  rawText: string;
}

@Injectable()
export class AiClientService {
  private geminiClient?: GoogleGenAI;
  private openaiClient?: OpenAI;

  hasProvider(provider: AiProviderName): boolean {
    if (provider === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
    return Boolean(process.env.OPENAI_API_KEY);
  }

  getOrderedProviders(): AiProviderName[] {
    return process.env.VISION_PRIMARY === 'openai' ? ['openai', 'gemini'] : ['gemini', 'openai'];
  }

  getProviderCostMicroUsd(provider: AiProviderName): number {
    if (provider === 'gemini') {
      const val = Number(process.env.GEMINI_VISION_COST_MICRO_USD ?? 500);
      return Number.isFinite(val) && val >= 0 ? Math.round(val) : 500;
    }
    const val = Number(process.env.OPENAI_VISION_COST_MICRO_USD ?? 1500);
    return Number.isFinite(val) && val >= 0 ? Math.round(val) : 1500;
  }

  private getGeminiClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    this.geminiClient ??= new GoogleGenAI({ apiKey });
    return this.geminiClient;
  }

  private getOpenAiClient(): OpenAI {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
    this.openaiClient ??= new OpenAI({ apiKey });
    return this.openaiClient;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async extractVision(params: AiVisionParams & { provider?: AiProviderName }): Promise<AiCallResult> {
    const provider = params.provider ?? this.getOrderedProviders().find((p) => this.hasProvider(p));
    if (!provider) {
      throw new Error('No AI vision provider API key configured');
    }

    const startedAt = Date.now();
    const timeoutMs = params.timeoutMs ?? 15_000;

    if (provider === 'gemini') {
      const model = process.env.GEMINI_VISION_MODEL ?? 'gemini-3.5-flash-lite';
      const client = this.getGeminiClient();
      const response = await this.withTimeout(
        client.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { text: params.prompt },
                { inlineData: { mimeType: params.mimeType, data: params.imageBuffer.toString('base64') } },
              ],
            },
          ],
          config: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseJsonSchema: params.jsonSchema,
          },
        }),
        timeoutMs,
        'gemini vision',
      );
      if (!response.text) throw new Error('Gemini returned empty vision response');
      return {
        provider,
        model,
        latencyMs: Date.now() - startedAt,
        estimatedCostMicroUsd: this.getProviderCostMicroUsd(provider),
        rawText: response.text,
      };
    }

    const model = process.env.OPENAI_VISION_MODEL ?? 'gpt-5-nano';
    const client = this.getOpenAiClient();
    const dataUrl = `data:${params.mimeType};base64,${params.imageBuffer.toString('base64')}`;
    const completion = await this.withTimeout(
      client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: params.prompt },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: params.schemaName ?? 'egypt_payment_receipt',
            strict: true,
            schema: params.jsonSchema,
          },
        },
      }),
      timeoutMs,
      'openai vision',
    );
    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned empty vision response');
    return {
      provider,
      model,
      latencyMs: Date.now() - startedAt,
      estimatedCostMicroUsd: this.getProviderCostMicroUsd(provider),
      rawText: content,
    };
  }

  async extractJson(params: AiJsonParams & { provider?: AiProviderName }): Promise<AiCallResult> {
    const provider = params.provider ?? this.getOrderedProviders().find((p) => this.hasProvider(p));
    if (!provider) {
      throw new Error('No AI text provider API key configured');
    }

    const startedAt = Date.now();
    const timeoutMs = params.timeoutMs ?? 12_000;

    if (provider === 'gemini') {
      const model = process.env.GEMINI_VISION_MODEL ?? 'gemini-3.5-flash-lite';
      const client = this.getGeminiClient();
      const response = await this.withTimeout(
        client.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [{ text: `${params.systemPrompt}\n\n${params.userText}` }],
            },
          ],
          config: {
            temperature: 0,
            responseMimeType: 'application/json',
          },
        }),
        timeoutMs,
        'gemini text',
      );
      if (!response.text) throw new Error('Gemini returned empty JSON response');
      return {
        provider,
        model,
        latencyMs: Date.now() - startedAt,
        estimatedCostMicroUsd: this.getProviderCostMicroUsd(provider),
        rawText: response.text,
      };
    }

    const model = process.env.OPENAI_VISION_MODEL ?? 'gpt-5-nano';
    const client = this.getOpenAiClient();
    const completion = await this.withTimeout(
      client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userText },
        ],
        response_format: { type: 'json_object' },
      }),
      timeoutMs,
      'openai text',
    );
    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned empty JSON response');
    return {
      provider,
      model,
      latencyMs: Date.now() - startedAt,
      estimatedCostMicroUsd: this.getProviderCostMicroUsd(provider),
      rawText: content,
    };
  }
}
