import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import {
  RECEIPT_EXTRACTION_PROMPT,
  VISION_JSON_SCHEMA,
  VisionExtractionSchema,
} from './vision.schema.js';
import { VisionProvider, VisionProviderOutput } from './vision-provider.interface.js';

@Injectable()
export class OpenAiVisionProvider implements VisionProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.model = process.env.OPENAI_VISION_MODEL ?? 'gpt-5-nano';
  }

  async extractReceipt(imageBuffer: Buffer, mimeType: string): Promise<VisionProviderOutput> {
    const startedAt = Date.now();
    const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RECEIPT_EXTRACTION_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'egypt_payment_receipt',
          strict: true,
          schema: VISION_JSON_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned empty vision response');

    const parsed = VisionExtractionSchema.parse(JSON.parse(content));
    return {
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - startedAt,
      data: parsed,
    };
  }
}