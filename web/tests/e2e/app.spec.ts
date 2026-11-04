/**
 * End to end in Google Chrome: pick a video, find the heads, change the settings, save the blurred video and check the file.
 * APP_VIDEO names the video (default: a short synthetic clip with 90 degree rotation metadata and AAC sound).
 */
import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';

const VIDEO = process.env.APP_VIDEO ?? '/data/syn_rot90_6s.mp4';
const OUT = process.env.APP_OUT ?? '';

test('find heads, adjust and save a blurred video', async ({ baseURL }) => {
  test.setTimeout(40 * 60_000);
  // persistent profile: the default context has a tiny storage quota for the stand-in of the save dialog
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'futsalblur-e2e-')), { channel: 'chrome', headless: true, baseURL });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.addInitScript(() => {
    // headless runs cannot click through the native save dialog: write into the origin private file system
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle('e2e_output.mp4', { create: true });
    };
  });
  try {
    await page.goto(`/${process.env.APP_QUERY ?? ''}`);
    // the first visit installs the service worker and reloads once; WASM threads need the isolated page
    await expect.poll(() => page.evaluate(() => crossOriginIsolated).catch(() => false), { timeout: 60_000 }).toBe(true);
    await page.setInputFiles('input[type=file]', VIDEO);
    await page.getByRole('button', { name: /Find heads|머리 찾기/ }).click();
    await expect(page.getByRole('heading', { name: /Check and adjust|확인하고/ })).toBeVisible({ timeout: 30 * 60_000 });
    const diag = JSON.parse((await page.locator('details pre').textContent()) ?? '{}');
    console.log('diagnostics', diag);
    expect(diag.frames).toBeGreaterThan(0);
    expect(diag.detectionFrames).toBe(Math.ceil(diag.frames / 3));

    // the presets set the threshold; the preview is drawn
    await page.getByLabel(/Least blur|흐림 최소/).check();
    await expect(page.locator('legend strong')).toHaveText('0.30');
    await page.getByLabel(/Balanced|균형/).check();
    await expect(page.locator('legend strong')).toHaveText('0.20');
    await expect.poll(() => page.locator('canvas.preview').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
    // the detections file (APP_DETS keeps a copy, e.g. for a comparison with the reference tool)
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /detections|검출 결과/ }).click()]);
    const dets = JSON.parse(readFileSync(await download.path(), 'utf8'));
    expect(dets.frames.length).toBe(diag.detectionFrames);
    if (process.env.APP_DETS) writeFileSync(process.env.APP_DETS, JSON.stringify(dets));

    await page.getByRole('button', { name: /Save blurred video|흐린 영상 저장/ }).click();
    const ended = page.getByText(/Saved:|저장했습니다|Error:|오류:/);
    await expect(ended).toBeVisible({ timeout: 30 * 60_000 });
    expect(await ended.textContent()).toMatch(/Saved:|저장했습니다/);
    // read the written file back in 4 MB pieces (base64): a whole 4K file as one value would not fit the test's memory
    const size = await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('e2e_output.mp4')).getFile()).size);
    const parts: Buffer[] = [];
    for (let off = 0; off < size; off += 4 << 20) {
      const b64 = await page.evaluate(async ([o, n]) => {
        const f = await (await (await navigator.storage.getDirectory()).getFileHandle('e2e_output.mp4')).getFile();
        const piece = new Uint8Array(await f.slice(o, o + n).arrayBuffer());
        let s = '';
        for (let i = 0; i < piece.length; i += 0x8000) s += String.fromCharCode(...piece.subarray(i, i + 0x8000));
        return btoa(s);
      }, [off, 4 << 20] as [number, number]);
      parts.push(Buffer.from(b64, 'base64'));
    }
    const buf = new Uint8Array(Buffer.concat(parts));
    if (OUT) writeFileSync(OUT, buf);
    const out = new Input({ source: new BufferSource(buf), formats: ALL_FORMATS });
    const video = (await out.getPrimaryVideoTrack())!;
    const durationS = (await out.computeDuration()) - (await video.getFirstTimestamp());
    const audio = await out.getPrimaryAudioTrack();
    console.log('output', { bytes: buf.length, durationS, width: video.displayWidth, height: video.displayHeight, rotation: video.rotation,
      codec: video.codec, audio: audio?.codec ?? null });
    // the picture keeps its display orientation, without rotation metadata, and the sound is kept
    expect(video.rotation).toBe(0);
    expect([video.displayWidth, video.displayHeight]).toEqual([diag.width, diag.height]);
    expect(Math.abs(durationS - diag.durationS)).toBeLessThan(0.2);
    expect(audio?.codec ?? null).toBe(diag.hasAudio ? 'aac' : null);
  } finally {
    console.log(logs.filter((l) => /error|warn/i.test(l)).slice(0, 20).join('\n'));
    await ctx.close();
  }
});
