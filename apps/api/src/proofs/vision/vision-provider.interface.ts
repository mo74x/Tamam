import { VisionExtractionResult } from './vision.schema.js';

export const VISION_PROVIDER = Symbol('VISION_PROVIDER');

export interface VisionProviderOutput {
  provider: string;
  model: string;
  latencyMs: number;
  data: VisionExtractionResult;
}

export interface VisionProvider {
  readonly name: string;
  extractReceipt(imageBuffer: Buffer, mimeType: string): Promise<VisionProviderOutput>;
}