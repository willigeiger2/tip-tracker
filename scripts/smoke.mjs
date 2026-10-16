#!/usr/bin/env node
// Browser smoke test: drives the app in headless Chromium against an already-running dev server
// (default http://localhost:4321; start it yourself with `npm run dev`). Uses a fake camera, clicks
// through sources and tracking modes, and fails on any page error or console error.
//
//   npm run smoke
//   npm run smoke -- --url http://localhost:4321 --video-url <stream manifest url> --headed

import process from 'node:process';
import { chromium } from 'playwright';

const DEFAULT_VIDEO_URL =
  'https://customer-9cbb9x7nxdw5hb57.cloudflarestream.com/bcbf1e349f2b494a3dfa31deb8928452/manifest/video.m3u8';

function parseArgs(argv) {
  const opts = { url: 'http://localhost:4321', videoUrl: DEFAULT_VIDEO_URL, headed: false, video: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') opts.url = argv[++i];
    else if (arg === '--video-url') opts.videoUrl = argv[++i];
    else if (arg === '--headed') opts.headed = true;
    else if (arg === '--no-video') opts.video = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

// Console noise that is expected and not an app failure.
const IGNORED_CONSOLE = [
  /INFO: Created TensorFlow Lite/i,
  /Graph successfully started running/i,
  /GL version/i,
  /OpenGL error checking is disabled/i,
  /NORM_RECT/i,
  /\[vite\]/i,
  /Failed to load resource: the server responded with a status of 404.*favicon/i,
];

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const problems = [];
  const steps = [];

  try {
    const res = await fetch(opts.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`Dev server not reachable at ${opts.url} (${err.message}). Start it with: npm run dev`);
    process.exit(2);
  }

  const browser = await chromium.launch({
    headless: !opts.headed,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext({
    permissions: ['camera'],
    viewport: { width: 1280, height: 2000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  // Never write to the track library from a smoke run.
  let blockedWrites = 0;
  await page.route('**/api/tracks/**', (route) => {
    if (route.request().method() === 'GET') return route.continue();
    blockedWrites++;
    return route.abort();
  });

  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    if (blockedWrites > 0 && /Failed to load resource: net::ERR_FAILED/.test(text)) return;
    problems.push(`console.error: ${text}`);
  });

  const status = () => page.locator('#detectionStatus').innerText();
  const waitForStatus = async (predicate, label, timeoutMs = 30000) => {
    const start = Date.now();
    let last = '';
    while (Date.now() - start < timeoutMs) {
      last = await status();
      if (predicate(last)) return last;
      await page.waitForTimeout(250);
    }
    throw new Error(`Timed out waiting for ${label}; last status: "${last}"`);
  };
  const step = async (name, fn) => {
    const before = problems.length;
    try {
      const detail = await fn();
      const newProblems = problems.length - before;
      steps.push(`${newProblems ? 'FAIL' : 'ok  '} ${name}${detail ? ` - ${detail}` : ''}`);
    } catch (err) {
      steps.push(`FAIL ${name} - ${err.message}`);
      problems.push(`${name}: ${err.message}`);
    }
  };
  const visible = (selector) => page.locator(selector).isVisible();
  // Clicking outside the panel (e.g. the transport bar) collapses the menu, as in normal use.
  const ensureMenuOpen = async () => {
    if (await page.locator('#controls.collapsed').count()) await page.click('#menuToggle');
  };

  await step('load page (camera, hand mode)', async () => {
    await page.goto(opts.url);
    return waitForStatus((s) => /Running/.test(s), 'hand model + camera', 60000);
  });

  await step('open menu', async () => {
    await page.click('#menuToggle');
    if (await page.locator('#controls.collapsed').count()) throw new Error('menu did not open');
  });

  for (const mode of ['pose', 'fencers', 'hand']) {
    await step(`tracking mode: ${mode}`, async () => {
      await page.selectOption('#trackingMode', mode);
      await page.waitForTimeout(300);
      const s = await waitForStatus((t) => /Running|Ready/.test(t), `${mode} model`, 60000);
      const fencersShown = await visible('#fencersDebugGroup');
      if ((mode === 'fencers') !== fencersShown) throw new Error(`fencers panel visible=${fencersShown}`);
      return s;
    });
  }

  await step('display controls', async () => {
    await page.selectOption('#debugMode', 'all');
    await page.locator('#trailLength').fill('60');
    await page.waitForTimeout(500);
    await page.selectOption('#debugMode', 'none');
    await page.click('#clearTrails');
  });

  await step('settings bindings', async () => {
    await page.selectOption('#trackingMode', 'fencers');
    await waitForStatus((t) => /Running/.test(t), 'fencers model', 60000);
    await page.locator('#fencerBTipExtension').fill('5.2');
    const shown = await page.locator('#fencerBTipExtensionValue').innerText();
    if (shown !== '5.2') throw new Error(`fencer B tip extension shows "${shown}"`);
    await page.locator('#fencerAWristWeight').fill('60');
    const wrist = await page.locator('#fencerAWristWeightValue').innerText();
    if (wrist !== '60') throw new Error(`fencer A wrist blend shows "${wrist}"`);
    await page.selectOption('#fencerBWeaponArm', 'right');
    await page.check('#fencersDebugOverlay');
    await page.waitForTimeout(500);
    await page.uncheck('#fencersDebugOverlay');
    await page.selectOption('#fencerBWeaponArm', 'auto');
    await page.locator('#fencerBTipExtension').fill('4.4');
    await page.locator('#fencerAWristWeight').fill('35');
    await page.selectOption('#trackingMode', 'hand');
    await waitForStatus((t) => /Running/.test(t), 'hand model', 60000);
  });

  await step('camera stop/start', async () => {
    await page.click('#toggleCamera');
    const stopped = await page.locator('#toggleCamera').innerText();
    if (stopped !== 'Start Camera') throw new Error(`button says "${stopped}" after stop`);
    await page.click('#toggleCamera');
    await waitForStatus((t) => /Running/.test(t), 'camera restart', 30000);
    const started = await page.locator('#toggleCamera').innerText();
    if (started !== 'Stop Camera') throw new Error(`button says "${started}" after start`);
  });

  if (opts.video) {
    await step('switch to video source', async () => {
      await page.selectOption('#sourceMode', 'video');
      if (!(await visible('#videoSourceGroup'))) throw new Error('video URL group hidden');
      if (!(await visible('#transportPlayPause'))) throw new Error('transport hidden');
      return status();
    });

    await step('load video', async () => {
      await page.fill('#videoUrl', opts.videoUrl);
      await page.click('#loadVideo');
      return waitForStatus((s) => /Video loaded|Running|tap Play/.test(s), 'video load', 60000);
    });

    await step('play, step, pause (fencers)', async () => {
      await page.selectOption('#trackingMode', 'fencers');
      await waitForStatus((s) => !/Loading/.test(s), 'fencers model', 60000);
      const isPaused = () => page.evaluate(() => document.querySelector('video').paused);
      // The default clip has no fencers in frame for the first ~8 s.
      await page.evaluate(() => {
        document.querySelector('video').currentTime = 10;
      });
      await page.waitForTimeout(500);
      if (await isPaused()) await page.click('#transportPlayPause');
      const t0 = await page.evaluate(() => document.querySelector('video').currentTime);
      await page.waitForFunction(
        (start) => document.querySelector('video').currentTime > start + 2,
        t0,
        { timeout: 30000 }
      );
      // Keep playing until a useful number of draft samples is captured (model warm-up varies).
      await page.waitForFunction(
        () => {
          const m = /Captured (\d+)/.exec(document.querySelector('#recordedGenerateHint')?.textContent ?? '');
          return m !== null && Number(m[1]) >= 20;
        },
        null,
        { timeout: 30000 }
      );
      await page.click('#transportPlayPause');
      if (!(await isPaused())) throw new Error('pause did not pause');
      const samples = await page.locator('#recordedGenerateHint').innerText();
      if (!/Captured \d+/.test(samples) || /\(A 0, B 0\)/.test(samples)) throw new Error(`no draft samples captured: "${samples}"`);
      await page.click('#transportStepForward');
      await page.click('#transportStepBack');
      const readout = await page.locator('#transportReadout').innerText();
      const draftEnabled = await page.locator('#recordedGenerateDraft').isEnabled();
      return `readout "${readout}", draft button enabled=${draftEnabled}`;
    });

    await step('fencers trace export', async () => {
      await ensureMenuOpen();
      const status = await page.locator('#fencersTraceStatus').innerText();
      if (!/Trace: \d+ entries/.test(status) || /Trace: 0 entries/.test(status)) throw new Error(`trace status "${status}"`);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#fencersTraceExport')]);
      if (await page.locator('#controls.collapsed').count()) throw new Error('export collapsed the panel');
      const trace = JSON.parse(await streamToString(await download.createReadStream()));
      const withPose = trace.trace.filter((e) => e.detections.some((d) => d.pose)).length;
      if (!trace.trace.length || !withPose) throw new Error('trace export has no entries with pose landmarks');
      return `${trace.trace.length} entries, ${download.suggestedFilename()}`;
    });

    await step('generate recorded draft', async () => {
      await ensureMenuOpen();
      const keyframeTotal = async () =>
        Number(/^(\d+) keyframe/.exec(await page.locator('#recordedStatus').innerText())?.[1] ?? 0);
      const before = await keyframeTotal();
      let dialogText = null;
      const onDialog = (dialog) => {
        dialogText = dialog.message();
        void dialog.accept();
      };
      page.once('dialog', onDialog);
      await page.click('#recordedGenerateDraft');
      await page.waitForTimeout(500);
      page.off('dialog', onDialog);
      const mode = await page.locator('#trackingMode').inputValue();
      if (mode !== 'recorded') throw new Error(`tracking mode is "${mode}" after draft`);
      const after = await keyframeTotal();
      if (dialogText === null) {
        // Nothing existed in the captured range: the draft is purely added.
        if (after <= before) throw new Error(`draft added nothing: before ${before}, after ${after}`);
        return `before ${before}, after ${after} (no overlap)`;
      }
      const replaced = Number(/Replace (\d+) existing/.exec(dialogText)?.[1] ?? NaN);
      const draft = /draft \(A (\d+), B (\d+)\)/.exec(dialogText);
      if (!draft) throw new Error(`unexpected dialog: ${dialogText}`);
      const added = Number(draft[1]) + Number(draft[2]);
      if (added < 1) throw new Error(`empty draft: ${dialogText}`);
      // Range-scoped merge: keyframes outside the captured range must survive.
      if (after !== before - replaced + added) {
        throw new Error(`merge mismatch: before ${before}, replaced ${replaced}, added ${added}, after ${after}`);
      }
      return `before ${before}, replaced ${replaced}, added ${added}, after ${after}`;
    });

    await step('re-draft over existing keyframes replaces only the captured range', async () => {
      await ensureMenuOpen();
      const keyframeTotal = async () =>
        Number(/^(\d+) keyframe/.exec(await page.locator('#recordedStatus').innerText())?.[1] ?? 0);
      const before = await keyframeTotal();
      await page.selectOption('#trackingMode', 'fencers');
      await page.evaluate(() => {
        const v = document.querySelector('video');
        v.pause();
        v.currentTime = 10;
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => document.querySelector('video').play());
      try {
        await page.waitForFunction(
          () =>
            document.querySelector('video').currentTime >= 11.5 &&
            Number(/Captured (\d+)/.exec(document.querySelector('#recordedGenerateHint')?.textContent ?? '')?.[1] ?? 0) >= 20,
          null,
          { timeout: 30000 }
        );
      } catch {
        const t = await page.evaluate(() => document.querySelector('video').currentTime.toFixed(2));
        throw new Error(`video did not play 10s -> 11.5s with samples (stalled at ${t}s?)`);
      }
      await page.evaluate(() => document.querySelector('video').pause());
      await ensureMenuOpen();
      let dialogText = null;
      const onDialog = (dialog) => {
        dialogText = dialog.message();
        void dialog.accept();
      };
      page.once('dialog', onDialog);
      await page.click('#recordedGenerateDraft');
      await page.waitForTimeout(500);
      page.off('dialog', onDialog);
      if (dialogText === null) throw new Error('expected a replace confirmation for an overlapping draft');
      const replaced = Number(/Replace (\d+) existing/.exec(dialogText)?.[1] ?? NaN);
      const draft = /draft \(A (\d+), B (\d+)\)/.exec(dialogText);
      if (!draft || !(replaced > 0)) throw new Error(`unexpected dialog: ${dialogText}`);
      const added = Number(draft[1]) + Number(draft[2]);
      const after = await keyframeTotal();
      if (after !== before - replaced + added) {
        throw new Error(`merge mismatch: before ${before}, replaced ${replaced}, added ${added}, after ${after}`);
      }
      return `${dialogText.split('\n')[0].slice(0, 90)} -> ${before} - ${replaced} + ${added} = ${after}`;
    });

    await step('recorded mode panel', async () => {
      await ensureMenuOpen();
      await page.selectOption('#trackingMode', 'recorded');
      await page.waitForTimeout(300);
      if (!(await visible('#recordedPanel'))) throw new Error('recorded panel hidden');
      return page.locator('#recordedStatus').innerText();
    });

    await step('keyframe editing', async () => {
      await page.check('#recordedEditToggle');
      if (!(await visible('#recordedEditorControls'))) throw new Error('editor controls hidden');
      await page.selectOption('#recordedAutoAdvance', '0');
      await page.selectOption('#recordedActiveTrack', 'B');
      const rows = () => page.locator('#recordedKeyframeList .recorded-keyframe-row').count();
      const before = await rows();
      await page.click('#transportStepForward');
      await page.waitForTimeout(300);
      // Click on the video area (left of the panel) to place a keyframe.
      await page.mouse.click(300, 400);
      await page.waitForTimeout(300);
      const afterAdd = await rows();
      if (afterAdd !== before + 1 && afterAdd !== before) throw new Error(`rows ${before} -> ${afterAdd}`);
      const rowStyled = await page.evaluate(() => {
        const row = document.querySelector('#recordedKeyframeList .recorded-keyframe-row');
        return row ? getComputedStyle(row).display : 'none';
      });
      if (rowStyled !== 'grid') throw new Error(`keyframe rows not styled (display: ${rowStyled})`);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);
      const afterDelete = await rows();
      await page.keyboard.press(']');
      await page.keyboard.press('[');
      await page.uncheck('#recordedEditToggle');
      return `rows ${before} -> ${afterAdd} -> ${afterDelete}; ${await page.locator('#recordedStatus').innerText()}`;
    });

    await step('hits: toggle with X, list and seek-bar tick', async () => {
      await ensureMenuOpen();
      if (!(await page.locator('#recordedEditToggle').isChecked())) await page.check('#recordedEditToggle');
      await page.evaluate(() => {
        const v = document.querySelector('video');
        v.pause();
        v.currentTime = 12.0;
      });
      await page.waitForTimeout(400);
      const rows = () => page.locator('#recordedHitList .recorded-hit-row').count();
      const before = await rows();
      await page.locator('#transportPlayPause').focus();
      await page.keyboard.press('x');
      await page.waitForTimeout(200);
      const added = await rows();
      const ticks = await page.locator('#transportHitTicks span').count();
      if (added !== before + 1 || ticks !== added) throw new Error(`rows ${before} -> ${added}, ticks ${ticks}`);
      await page.keyboard.press('x');
      await page.waitForTimeout(200);
      if ((await rows()) !== before) throw new Error('second X did not remove the hit');
      await page.keyboard.press('x'); // leave one hit for the MP4 export step
      return `rows ${before} -> ${added} -> ${before} -> ${added}`;
    });

    await step('mp4 export (short range)', async () => {
      await ensureMenuOpen();
      await page.uncheck('#recordedEditToggle');
      await page.fill('#exportStart', '0:12.0');
      await page.fill('#exportEnd', '0:12.3');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120000 }),
        page.click('#exportMp4'),
      ]);
      const bytes = (await streamToString(await download.createReadStream())).length;
      const status = await page.locator('#exportStatus').innerText();
      if (!/\.mp4$/.test(download.suggestedFilename()) || bytes < 1000) {
        throw new Error(`bad export: ${download.suggestedFilename()} ${bytes} bytes; ${status}`);
      }
      if (!/Exported \d+ frames, \d+x\d+/.test(status)) throw new Error(`status "${status}"`);
      return status;
    });

    await step('recorded export / import', async () => {
      await ensureMenuOpen();
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#recordedExportJson')]);
      const json = await streamToString(await download.createReadStream());
      await ensureMenuOpen();
      await page.fill('#recordedJsonInput', json);
      await page.click('#recordedImportPaste');
      await page.waitForTimeout(300);
      const s = await page.locator('#recordedStatus').innerText();
      if (!/keyframes? loaded|Imported|Unsaved|Saved/.test(s)) throw new Error(`status after import "${s}"`);
      return s;
    });

    await step('saved videos panel', async () => {
      await ensureMenuOpen();
      if (!(await visible('#savedVideosPanel'))) throw new Error('saved videos panel hidden');
      await page.click('#savedVideosRefresh');
      await page.waitForTimeout(1000);
      return page.locator('#savedVideosStatus').innerText();
    });

    await step('auto-load via ?video= param', async () => {
      await page.goto(`${opts.url}/?video=${encodeURIComponent(opts.videoUrl)}`);
      const s = await waitForStatus((t) => /Video loaded|Running|tap Play/.test(t), 'auto-loaded video', 60000);
      const source = await page.locator('#sourceMode').inputValue();
      const url = await page.locator('#videoUrl').inputValue();
      if (source !== 'video' || url !== opts.videoUrl) throw new Error(`source=${source} url=${url}`);
      return s;
    });

    await step('back to camera', async () => {
      await ensureMenuOpen();
      await page.selectOption('#sourceMode', 'camera');
      return waitForStatus((s) => /Running|Ready/.test(s), 'camera restart', 30000);
    });
  }

  await browser.close();

  console.log(steps.join('\n'));
  if (blockedWrites) console.log(`\n(${blockedWrites} track-library write(s) blocked)`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nSmoke test passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
