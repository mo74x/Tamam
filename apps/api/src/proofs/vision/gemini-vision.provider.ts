import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import {
  RECEIPT_EXTRACTION_PROMPT,
  VISION_JSON_SCHEMA,
  VisionExtractionSchema,
} from './vision.schema.js';
import { VisionProvider, VisionProviderOutput } from './vision-provider.interface.js';

@Injectable()
export class GeminiVisionProvider implements VisionProvider {
  readonly name = 'gemini';
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.model = process.env.GEMINI_VISION_MODEL ?? 'gemini-3.5-flash-lite';
  }

  async extractReceipt(imageBuffer: Buffer, mimeType: string): Promise<VisionProviderOutput> {
    const startedAt = Date.now();
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: RECEIPT_EXTRACTION_PROMPT },
            { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
          ],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: VISION_JSON_SCHEMA,
      },
    });

    if (!response.text) {
      throw new Error('Gemini returned empty vision response');
    }

    const parsed = VisionExtractionSchema.parse(JSON.parse(response.text));
    return {
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - startedAt,
      data: parsed,
    };
  }
}