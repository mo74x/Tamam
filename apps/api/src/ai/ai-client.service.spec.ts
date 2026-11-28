import { AiClientService } from './ai-client.service.js';
import { AiModule } from './ai.module.js';

const { generateContentMock, chatCompletionsCreateMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  chatCompletionsCreateMock: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: chatCompletionsCreateMock } };
  },
}));

describe('AiClientService', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VISION_PRIMARY;
    delete process.env.GEMINI_VISION_COST_MICRO_USD;
    delete process.env.OPENAI_VISION_COST_MICRO_USD;
  });

  afterAll(() => {
    process.env = envSnapshot;
  });

  it('detects configured providers and orders them according to VISION_PRIMARY', () => {
    const ai = new AiClientService();
    expect(ai.hasProvider('gemini')).toBe(false);
    expect(ai.hasProvider('openai')).toBe(false);
    expect(ai.getOrderedProviders()).toEqual(['gemini', 'openai']);

    process.env.GEMINI_API_KEY = 'gem-key';
    process.env.OPENAI_API_KEY = 'oai-key';
    process.env.VISION_PRIMARY = 'openai';

    expect(ai.hasProvider('gemini')).toBe(true);
    expect(ai.hasProvider('openai')).toBe(true);
    expect(ai.getOrderedProviders()).toEqual(['openai', 'gemini']);
  });

  it('throws explicit errors when no provider API keys are configured', async () => {
    const ai = new AiClientService();
    await expect(
      ai.extractVision({
        imageBuffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
        prompt: 'extract',
        jsonSchema: {},
      }),
    ).rejects.toThrow(/No AI vision provider API key configured/);

    await expect(
      ai.extractJson({ systemPrompt: 'sys', userText: 'usr' }),
    ).rejects.toThrow(/No AI text provider API key configured/);
  });

  it('calls Gemini lazily and reports configured micro-USD cost', async () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    process.env.GEMINI_VISION_COST_MICRO_USD = '450';
    generateContentMock.mockResolvedValue({ text: '{"ok":true}' });

    const ai = new AiClientService();
    const res = await ai.extractJson({
      systemPrompt: 'parse sms',
      userText: 'EGP 650',
    });

    expect(res.provider).toBe('gemini');
    expect(res.estimatedCostMicroUsd).toBe(450);
    expect(res.rawText).toBe('{"ok":true}');
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to OpenAI when primary is openai and propagates timeout errors', async () => {
    process.env.OPENAI_API_KEY = 'oai-key';
    process.env.OPENAI_VISION_COST_MICRO_USD = '1200';
    process.env.VISION_PRIMARY = 'openai';

    chatCompletionsCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: '{"amountEgp":"650"}' } }],
    });

    const ai = new AiClientService();
    const ok = await ai.extractVision({
      imageBuffer: Buffer.from('jpeg-bytes'),
      mimeType: 'image/jpeg',
      prompt: 'extract receipt',
      jsonSchema: { type: 'object' },
    });
    expect(ok.provider).toBe('openai');
    expect(ok.estimatedCostMicroUsd).toBe(1200);

    chatCompletionsCreateMock.mockImplementationOnce(
      () => new Promise(() => { /* never resolves */ }),
    );
    await expect(
      ai.extractJson({ systemPrompt: 'sys', userText: 'usr', timeoutMs: 15 }),
    ).rejects.toThrow(/openai text timeout/);
  });

  it('exports AiModule cleanly', () => {
    expect(AiModule).toBeDefined();
  });
});
