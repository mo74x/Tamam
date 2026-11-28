import 'dotenv/config';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { extname, join, resolve } from 'path';
import { AiClientService } from '../src/ai/ai-client.service.js';
import { parseCairoTimestampToUtc } from '../src/common/cairo-time.js';
import { normalizeName, normalizeRef, parseAmountToPiasters } from '../src/common/normalize.js';
import { LlmEvidenceFallbackService } from '../src/evidence/parsers/llm-fallback.service.js';
import { ParserRegistryService } from '../src/evidence/parsers/parser-registry.service.js';
import { classifyNoise } from '../src/evidence/utils/otp-filter.js';
import { hammingDistance64, prepareReceiptImage } from '../src/proofs/utils/image-pipeline.js';
import { FallbackVisionProvider } from '../src/proofs/vision/fallback-vision.provider.js';
import { GeminiVisionProvider } from '../src/proofs/vision/gemini-vision.provider.js';
import { OpenAiVisionProvider } from '../src/proofs/vision/openai-vision.provider.js';

interface SmsFixture {
  id: string;
  senderApp: string | null;
  rawText: string;
  receivedAt: string;
  expected: {
    isCredit: boolean;
    amountPiasters?: string | number | null;
    ref?: string | null;
    sender?: string | null;
  };
}

interface ScreenshotManifestItem {
  file: string;
  expectedAmountPiasters?: string | number;
  expectedRef?: string | null;
  expectedTimestampLocal?: string | null;
}

interface CliArgs {
  smsFixturesPath?: string;
  screenshotsDir?: string;
  useLlm: boolean;
  dhashOnly: boolean;
  allowUnscopedFallback: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const out: CliArgs = {
    useLlm: false,
    dhashOnly: false,
    allowUnscopedFallback: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--sms-fixtures' && args[i + 1]) {
      out.smsFixturesPath = args[++i];
    } else if (a === '--screenshots-dir' && args[i + 1]) {
      out.screenshotsDir = args[++i];
    } else if (a === '--use-llm') {
      out.useLlm = true;
    } else if (a === '--dhash-only') {
      out.dhashOnly = true;
    } else if (a === '--allow-unscoped-fallback') {
      out.allowUnscopedFallback = true;
    }
  }
  return out;
}

async function evaluateSmsCorpus(
  fixturesPath: string,
  options: { useLlm: boolean; allowUnscopedFallback: boolean },
): Promise<boolean> {
  const absPath = resolve(fixturesPath);
  const fixtures = JSON.parse(readFileSync(absPath, 'utf8')) as SmsFixture[];

  const aiClient = new AiClientService();
  const llmFallback = options.useLlm
    ? new LlmEvidenceFallbackService(aiClient)
    : ({
        parse: async () => null,
      } as unknown as LlmEvidenceFallbackService);

  const registry = new ParserRegistryService(llmFallback);

  let creditsExpected = 0;
  let negativeExpected = 0;
  let falsePositives = 0;
  let amountExact = 0;
  let refExact = 0;
  let senderExact = 0;
  const failures: string[] = [];
  const byParser = new Map<string, number>();

  for (const fx of fixtures) {
    const receivedAt = new Date(fx.receivedAt);
    const noise = classifyNoise(fx.rawText);
    const parsed =
      noise === 'OK'
        ? await registry.parse(fx.senderApp, fx.rawText, receivedAt, {
            allowUnscopedFallback: options.allowUnscopedFallback,
          })
        : null;

    if (!fx.expected.isCredit) {
      negativeExpected++;
      if (parsed) {
        falsePositives++;
        failures.push(`[${fx.id}] False positive credit (${parsed.parserName}) on non-credit SMS`);
      }
      continue;
    }

    creditsExpected++;
    if (!parsed) {
      failures.push(`[${fx.id}] Failed to parse incoming credit (senderApp=${fx.senderApp ?? 'null'})`);
      continue;
    }

    byParser.set(parsed.parserName, (byParser.get(parsed.parserName) ?? 0) + 1);

    const expectedAmount =
      fx.expected.amountPiasters !== undefined && fx.expected.amountPiasters !== null
        ? BigInt(fx.expected.amountPiasters)
        : null;
    const expectedRef = normalizeRef(fx.expected.ref);
    const expectedSender = normalizeName(fx.expected.sender);

    if (expectedAmount === parsed.amountPiasters) {
      amountExact++;
    } else {
      failures.push(
        `[${fx.id}] Amount mismatch: expected=${expectedAmount?.toString()} got=${parsed.amountPiasters.toString()}`,
      );
    }

    if (expectedRef === parsed.ref) {
      refExact++;
    } else {
      failures.push(`[${fx.id}] Ref mismatch: expected=${expectedRef} got=${parsed.ref}`);
    }

    if (expectedSender === parsed.sender) {
      senderExact++;
    } else {
      failures.push(`[${fx.id}] Sender mismatch: expected=${expectedSender} got=${parsed.sender}`);
    }
  }

  const amountRate = creditsExpected > 0 ? amountExact / creditsExpected : 0;
  const refRate = creditsExpected > 0 ? refExact / creditsExpected : 0;
  const senderRate = creditsExpected > 0 ? senderExact / creditsExpected : 0;
  const fpRate = negativeExpected > 0 ? falsePositives / negativeExpected : 0;

  console.log('\n=== SMS Corpus Evaluation ===');
  console.log(`Fixtures: ${fixtures.length} (${creditsExpected} credits, ${negativeExpected} non-credits)`);
  console.log(`Parser breakdown: ${JSON.stringify(Object.fromEntries(byParser))}`);
  console.log(`Amount exact: ${amountExact}/${creditsExpected} (${(amountRate * 100).toFixed(1)}%)`);
  console.log(`Ref exact:    ${refExact}/${creditsExpected} (${(refRate * 100).toFixed(1)}%)`);
  console.log(`Sender exact: ${senderExact}/${creditsExpected} (${(senderRate * 100).toFixed(1)}%)`);
  console.log(`False positives (debits/OTPs): ${falsePositives}/${negativeExpected} (${(fpRate * 100).toFixed(1)}%)`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }

  const passed =
    creditsExpected > 0 &&
    falsePositives === 0 &&
    amountRate >= 0.9 &&
    refRate >= 0.9 &&
    senderRate >= 0.9;
  console.log(`SMS Q1 Gate: ${passed ? 'PASS' : 'FAIL'}`);
  return passed;
}

async function evaluateScreenshotsDir(
  dirPath: string,
  options: { dhashOnly: boolean },
): Promise<boolean> {
  const absDir = resolve(dirPath);
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const files = readdirSync(absDir)
    .filter((f) => imageExts.has(extname(f).toLowerCase()))
    .sort();

  const manifestPath = join(absDir, 'manifest.json');
  const manifestList = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as ScreenshotManifestItem[])
    : [];
  const manifestByFile = new Map(manifestList.map((m) => [m.file, m]));

  const aiClient = new AiClientService();
  const hasVision =
    !options.dhashOnly && (aiClient.hasProvider('gemini') || aiClient.hasProvider('openai'));
  const visionProvider = hasVision
    ? new FallbackVisionProvider(
        new GeminiVisionProvider(aiClient),
        new OpenAiVisionProvider(aiClient),
      )
    : null;

  const preparedRows: Array<{ file: string; sha256: string; phash64: bigint; jpegBytes: number }> = [];
  let manifestTotal = 0;
  let amountHits = 0;
  let refHits = 0;
  let timeHits = 0;
  let totalCostMicroUsd = 0;
  let visionCalls = 0;
  const failures: string[] = [];

  for (const file of files) {
    const buf = readFileSync(join(absDir, file));
    const prep = await prepareReceiptImage(buf);
    preparedRows.push({
      file,
      sha256: prep.sha256,
      phash64: prep.phash64,
      jpegBytes: prep.resizedJpeg.length,
    });

    if (!visionProvider) continue;

    const result = await visionProvider.extractReceipt(prep.resizedJpeg, 'image/jpeg');
    visionCalls++;
    totalCostMicroUsd += result.estimatedCostMicroUsd;

    const expected = manifestByFile.get(file);
    if (!expected) continue;
    manifestTotal++;

    const extractedAmount = result.data.amountEgp
      ? parseAmountToPiasters(result.data.amountEgp)
      : null;
    const expectedAmount =
      expected.expectedAmountPiasters !== undefined
        ? BigInt(expected.expectedAmountPiasters)
        : null;
    if (expectedAmount === extractedAmount) {
      amountHits++;
    } else {
      failures.push(
        `[${file}] Vision amount mismatch: expected=${expectedAmount?.toString()} got=${extractedAmount?.toString()}`,
      );
    }

    const extractedRef = normalizeRef(result.data.reference);
    const expectedRef = normalizeRef(expected.expectedRef);
    if (expectedRef === extractedRef) {
      refHits++;
    } else {
      failures.push(`[${file}] Vision ref mismatch: expected=${expectedRef} got=${extractedRef}`);
    }

    const extractedTime = parseCairoTimestampToUtc(result.data.timestampLocal);
    const expectedTime = parseCairoTimestampToUtc(expected.expectedTimestampLocal);
    if (
      (extractedTime === null && expectedTime === null) ||
      (extractedTime !== null &&
        expectedTime !== null &&
        Math.abs(extractedTime.getTime() - expectedTime.getTime()) <= 60_000)
    ) {
      timeHits++;
    } else {
      failures.push(
        `[${file}] Vision time mismatch: expected=${expectedTime?.toISOString()} got=${extractedTime?.toISOString()}`,
      );
    }
  }

  // Empirical pairwise dHash distance matrix
  const collisions: Array<{ a: string; b: string; dist: number; exactBytes: boolean }> = [];
  for (let i = 0; i < preparedRows.length; i++) {
    for (let j = i + 1; j < preparedRows.length; j++) {
      const dist = hammingDistance64(preparedRows[i].phash64, preparedRows[j].phash64);
      if (dist <= 6) {
        collisions.push({
          a: preparedRows[i].file,
          b: preparedRows[j].file,
          dist,
          exactBytes: preparedRows[i].sha256 === preparedRows[j].sha256,
        });
      }
    }
  }

  console.log('\n=== Screenshot & dHash Evaluation ===');
  console.log(`Images processed: ${preparedRows.length}`);
  console.log(`Pairwise dHash <= 6 collisions: ${collisions.length}`);
  for (const c of collisions) {
    console.log(`  - ${c.a} <-> ${c.b}: hamming=${c.dist} exactBytes=${c.exactBytes}`);
  }

  let passed = preparedRows.length > 0;

  if (visionProvider) {
    const avgCostUsd = visionCalls > 0 ? totalCostMicroUsd / visionCalls / 1_000_000 : 0;
    console.log(`Vision calls: ${visionCalls}, avg cost: $${avgCostUsd.toFixed(6)}/receipt`);
    if (manifestTotal > 0) {
      const amountRate = amountHits / manifestTotal;
      const refRate = refHits / manifestTotal;
      const timeRate = timeHits / manifestTotal;
      console.log(`Vision amount exact: ${amountHits}/${manifestTotal} (${(amountRate * 100).toFixed(1)}%)`);
      console.log(`Vision ref exact:    ${refHits}/${manifestTotal} (${(refRate * 100).toFixed(1)}%)`);
      console.log(`Vision time exact:   ${timeHits}/${manifestTotal} (${(timeRate * 100).toFixed(1)}%)`);
      passed = passed && amountRate >= 0.95 && refRate >= 0.9 && timeRate >= 0.9;
    }
  } else {
    console.log('Vision extraction skipped (--dhash-only or no GEMINI_API_KEY/OPENAI_API_KEY configured).');
  }

  if (failures.length > 0) {
    console.log('\nVision Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }

  console.log(`Screenshots Q1/Q2 Gate: ${passed ? 'PASS' : 'FAIL'}`);
  return passed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.smsFixturesPath && !args.screenshotsDir) {
    console.error(
      'Usage: pnpm --filter api eval:corpus -- [--sms-fixtures <path.json>] [--screenshots-dir <dir>] [--use-llm] [--dhash-only] [--allow-unscoped-fallback]',
    );
    process.exitCode = 1;
    return;
  }

  let allPassed = true;
  if (args.smsFixturesPath) {
    const smsOk = await evaluateSmsCorpus(args.smsFixturesPath, {
      useLlm: args.useLlm,
      allowUnscopedFallback: args.allowUnscopedFallback,
    });
    allPassed = allPassed && smsOk;
  }

  if (args.screenshotsDir) {
    const imgOk = await evaluateScreenshotsDir(args.screenshotsDir, {
      dhashOnly: args.dhashOnly,
    });
    allPassed = allPassed && imgOk;
  }

  if (!allPassed) {
    process.exitCode = 1;
  }
}

await main();
