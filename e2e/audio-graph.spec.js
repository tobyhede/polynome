import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("a high click renders inside its scheduled frame window", async ({ page }) => {
  const frames = await page.evaluate(async () => {
    const { scheduleClickVoice } = await import("/metronome.js");
    const sampleRate = 48_000;
    const context = new OfflineAudioContext(1, sampleRate / 10, sampleRate);

    scheduleClickVoice(context, context.destination, "high", 1, 0.025);
    const buffer = await context.startRendering();
    const samples = buffer.getChannelData(0);
    const audible = (sample) => Math.abs(sample) > 1e-7;
    const first = samples.findIndex(audible);
    let last = samples.length - 1;
    while (last >= 0 && !audible(samples[last])) last -= 1;

    return { first, last };
  });

  expect(frames.first).toBeGreaterThanOrEqual(1_200);
  expect(frames.first).toBeLessThanOrEqual(1_202);
  expect(frames.last).toBeGreaterThanOrEqual(2_820);
  expect(frames.last).toBeLessThanOrEqual(2_832);
});

test("step levels scale the click amplitude and off stays silent", async ({ page }) => {
  const rendered = await page.evaluate(async () => {
    const { scheduleClickVoice } = await import("/metronome.js");
    const sampleRate = 48_000;

    async function render(level) {
      const context = new OfflineAudioContext(1, sampleRate / 10, sampleRate);
      const source = scheduleClickVoice(
        context,
        context.destination,
        "high",
        level,
        0.025,
      );
      const buffer = await context.startRendering();
      const peak = buffer
        .getChannelData(0)
        .reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
      return { peak, scheduled: source !== null };
    }

    return Promise.all([0, 0.25, 0.5, 1].map(render));
  });

  const [off, quarter, half, full] = rendered;
  expect(off).toEqual({ peak: 0, scheduled: false });
  expect(quarter.peak / full.peak).toBeCloseTo(0.25, 2);
  expect(half.peak / full.peak).toBeCloseTo(0.5, 2);
  expect(full.scheduled).toBe(true);
});

test("layer panning separates the rendered stereo channels", async ({ page }) => {
  const renders = await page.evaluate(async () => {
    const { createLayerOutput, scheduleClickVoice } = await import(
      "/metronome.js"
    );
    const sampleRate = 48_000;

    async function render(pan) {
      const context = new OfflineAudioContext(2, sampleRate / 10, sampleRate);
      const { gain } = createLayerOutput(context, context.destination, {
        volume: 1,
        pan,
        muted: false,
      });
      scheduleClickVoice(context, gain, "high", 1, 0.025);
      const buffer = await context.startRendering();

      return [0, 1].map((channel) =>
        buffer
          .getChannelData(channel)
          .reduce((energy, sample) => energy + sample * sample, 0),
      );
    }

    return Promise.all([-1, 0, 1].map(render));
  });

  const [hardLeft, center, hardRight] = renders;
  expect(hardLeft[1]).toBeLessThan(hardLeft[0] * 0.001);
  expect(center[0] / center[1]).toBeCloseTo(1, 2);
  expect(hardRight[0]).toBeLessThan(hardRight[1] * 0.001);
});
