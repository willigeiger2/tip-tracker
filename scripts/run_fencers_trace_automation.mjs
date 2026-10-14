#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_APP_URL = 'http://127.0.0.1:4321';

function parseBoolean(value, flagName) {
  if (value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean for ${flagName}: ${value}`);
}

function parseNumber(value, flagName) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${flagName}: ${value}`);
  }
  return parsed;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const options = {
    videoUrl: '',
    outputJson: '',
    truthJson: '',
    appUrl: DEFAULT_APP_URL,
    startServer: true,
    headless: true,
    timeoutMs: 180000,
    settleMs: 300,
    frameStart: undefined,
    frameEnd: undefined,
    startTimeSec: undefined,
    endTimeSec: undefined,
    inferenceFps: undefined,
    refinementEnabled: undefined,
    adaptiveTuningEnabled: undefined,
    fencerATipExtension: undefined,
    fencerBTipExtension: undefined,
    fencerALengthSmoothingAlpha: undefined,
    fencerBLengthSmoothingAlpha: undefined,
    fencerAWristWeight: undefined,
    fencerBWristWeight: undefined,
    fencerAAngleOffsetDeg: undefined,
    fencerBAngleOffsetDeg: undefined,
    compareTraceJson: [],
  };

  const nextValue = (index, name) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--video-url':
        options.videoUrl = nextValue(i, arg);
        i += 1;
        break;
      case '--output-json':
        options.outputJson = nextValue(i, arg);
        i += 1;
        break;
      case '--truth-json':
        options.truthJson = nextValue(i, arg);
        i += 1;
        break;
      case '--app-url':
        options.appUrl = nextValue(i, arg);
        i += 1;
        break;
      case '--frame-start':
        options.frameStart = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--frame-end':
        options.frameEnd = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--start-time-sec':
        options.startTimeSec = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--end-time-sec':
        options.endTimeSec = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--inference-fps':
        options.inferenceFps = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--refinement-enabled':
        options.refinementEnabled = parseBoolean(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--adaptive-enabled':
        options.adaptiveTuningEnabled = parseBoolean(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--fencer-a-tip-extension':
        options.fencerATipExtension = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--fencer-b-tip-extension':
        options.fencerBTipExtension = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--fencer-a-length-smoothing':
        options.fencerALengthSmoothingAlpha = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--fencer-b-length-smoothing':
        options.fencerBLengthSmoothingAlpha = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--fencer-a-wrist-weight':
        options.fencerAWristWeight = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--fencer-b-wrist-weight':
        options.fencerBWristWeight = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--fencer-a-angle-offset':
        options.fencerAAngleOffsetDeg = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--fencer-b-angle-offset':
        options.fencerBAngleOffsetDeg = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--compare-trace-json':
        options.compareTraceJson.push(nextValue(i, arg));
        i += 1;
        break;
      case '--no-start-server':
        options.startServer = false;
        break;
      case '--headful':
        options.headless = false;
        break;
      case '--timeout-ms':
        options.timeoutMs = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--settle-ms':
        options.settleMs = parseNumber(nextValue(i, arg), arg);
        i += 1;
        break;
      case '--help':
      case '-h':
        return { options, help: true };
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.videoUrl) {
    throw new Error('Missing required --video-url');
  }

  if (!options.outputJson) {
    options.outputJson = path.resolve(
      REPO_ROOT,
      'trace-output',
      `tiptrack-fencers-trace-auto-${timestampForFile()}.json`
    );
  } else {
    options.outputJson = path.resolve(process.cwd(), options.outputJson);
  }

  options.compareTraceJson = options.compareTraceJson.map((file) => path.resolve(process.cwd(), file));

  return { options, help: false };
}

function printHelp() {
  console.log(`Run tip-track fencers tracing in Chromium and optionally evaluate against truth.

Usage:
  node scripts/run_fencers_trace_automation.mjs --video-url <url> [options]

Required:
  --video-url <url>                    Video URL (HLS or MP4 with CORS)

Common options:
  --output-json <path>                 Output trace JSON (default: trace-output/tiptrack-fencers-trace-auto-<ts>.json)
  --truth-json <path>                  Run evaluator against this truth JSON
  --frame-start <n>                    Optional frameAt30 lower bound for windowed evaluation
  --frame-end <n>                      Optional frameAt30 upper bound for windowed evaluation
  --start-time-sec <s>                 Seek to this playback time before capture
  --end-time-sec <s>                   Stop capture when playback reaches this time
  --inference-fps <n>                  App inference fps override (5-30)
  --refinement-enabled <bool>          Enable fencers refinement (true/false)
  --adaptive-enabled <bool>            Enable adaptive tuning (true/false)
  --fencer-a-tip-extension <n>
  --fencer-b-tip-extension <n>
  --fencer-a-wrist-weight <n>          0-1
  --fencer-b-wrist-weight <n>          0-1
  --fencer-a-length-smoothing <n>      0-1
  --fencer-b-length-smoothing <n>      0-1
  --fencer-a-angle-offset <deg>
  --fencer-b-angle-offset <deg>
  --compare-trace-json <path>          Repeatable baseline trace path for side-by-side evaluator output

Runner options:
  --app-url <url>                      App URL (default: http://127.0.0.1:4321)
  --no-start-server                    Reuse existing app server instead of starting npm run dev
  --headful                            Run browser with visible UI
  --timeout-ms <n>                     Capture timeout (default: 180000)
  --settle-ms <n>                      Delay after seek before play (default: 300)

Example:
  node scripts/run_fencers_trace_automation.mjs \
    --video-url "https://.../manifest/video.m3u8" \
    --truth-json "/Users/me/Downloads/tiptrack-short-clip-hand-edited.json" \
    --frame-start 450 --frame-end 760 \
    --adaptive-enabled true --fencer-a-tip-extension 4.4 --fencer-b-tip-extension 4.4
`);
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return;
    } catch {
      // Keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for app URL to respond: ${url}`);
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function startDevServer(appUrl) {
  const url = new URL(appUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`--app-url must use localhost/127.0.0.1 when auto-starting dev server: ${appUrl}`);
  }

  const port = url.port ? Number(url.port) : 4321;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['run', 'dev', '--', '--host', url.hostname, '--port', String(port)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(`[dev] ${String(chunk)}`);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[dev] ${String(chunk)}`);
  });

  const stop = () => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  };

  return { child, stop };
}

async function runEvaluator({ truthJson, traceJson, compareTraceJson, frameStart, frameEnd }) {
  if (!truthJson) return;

  const traces = [traceJson, ...compareTraceJson];
  const baseArgs = ['scripts/evaluate_fencers_trace.py', '--truth-json', truthJson, '--track-id', 'all'];
  for (const tracePath of traces) {
    baseArgs.push('--trace-json', tracePath);
  }

  console.log('\n[evaluator] Full-overlap metrics');
  await spawnCommand('python3', baseArgs, { cwd: REPO_ROOT, stdio: 'inherit' });

  if (frameStart === undefined && frameEnd === undefined) return;
  const windowArgs = [...baseArgs];
  if (frameStart !== undefined) windowArgs.push('--frame-start', String(Math.round(frameStart)));
  if (frameEnd !== undefined) windowArgs.push('--frame-end', String(Math.round(frameEnd)));

  console.log('\n[evaluator] Windowed metrics');
  await spawnCommand('python3', windowArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    printHelp();
    process.exit(1);
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  const { options } = parsed;
  const outputDir = path.dirname(options.outputJson);
  await mkdir(outputDir, { recursive: true });

  let devServer;
  let browser;
  try {
    if (options.startServer) {
      console.log(`[runner] Starting dev server at ${options.appUrl}`);
      devServer = startDevServer(options.appUrl);
      await waitForHttp(options.appUrl, 120000);
      console.log('[runner] Dev server is ready');
    } else {
      console.log(`[runner] Using existing app server ${options.appUrl}`);
      await waitForHttp(options.appUrl, 30000);
    }

    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: options.headless,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        console.log(`[page:${type}] ${msg.text()}`);
      }
    });

    await page.goto(options.appUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForFunction(() => Boolean(window.tipTrackAutomation), { timeout: options.timeoutMs });

    if (options.startTimeSec === undefined && options.frameStart !== undefined) {
      options.startTimeSec = Math.max(0, options.frameStart / 30);
    }
    if (options.endTimeSec === undefined && options.frameEnd !== undefined) {
      options.endTimeSec = Math.max(0, options.frameEnd / 30);
    }

    const runConfig = {
      videoUrl: options.videoUrl,
      startTimeSec: options.startTimeSec,
      endTimeSec: options.endTimeSec,
      settleMs: options.settleMs,
      timeoutMs: options.timeoutMs,
      inferenceFps: options.inferenceFps,
      refinementEnabled: options.refinementEnabled,
      adaptiveTuningEnabled: options.adaptiveTuningEnabled,
      fencerATipExtension: options.fencerATipExtension,
      fencerBTipExtension: options.fencerBTipExtension,
      fencerALengthSmoothingAlpha: options.fencerALengthSmoothingAlpha,
      fencerBLengthSmoothingAlpha: options.fencerBLengthSmoothingAlpha,
      fencerAWristWeight: options.fencerAWristWeight,
      fencerBWristWeight: options.fencerBWristWeight,
      fencerAAngleOffsetDeg: options.fencerAAngleOffsetDeg,
      fencerBAngleOffsetDeg: options.fencerBAngleOffsetDeg,
    };

    console.log('[runner] Starting automated capture...');
    const runResult = await page.evaluate(async (captureConfig) => {
      if (!window.tipTrackAutomation) {
        throw new Error('tipTrackAutomation API is not available on window');
      }
      return window.tipTrackAutomation.runFencersTraceCapture(captureConfig);
    }, runConfig);

    await writeFile(options.outputJson, JSON.stringify(runResult.payload, null, 2), 'utf-8');
    console.log(`[runner] Trace captured: ${runResult.traceEntries} entries`);
    console.log(`[runner] Capture window: ${runResult.startTimeSec.toFixed(3)}s -> ${runResult.endTimeSec.toFixed(3)}s`);
    console.log(`[runner] Wrote trace: ${options.outputJson}`);

    await runEvaluator({
      truthJson: options.truthJson,
      traceJson: options.outputJson,
      compareTraceJson: options.compareTraceJson,
      frameStart: options.frameStart,
      frameEnd: options.frameEnd,
    });
  } finally {
    if (browser) {
      await browser.close();
    }
    if (devServer) {
      devServer.stop();
    }
  }
}

main().catch((error) => {
  console.error(`[runner] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
