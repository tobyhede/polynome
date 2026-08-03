import { expect, test } from "@playwright/test";

const SAMPLE_RATE = 48_000;
const WHEN = 0.025;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("a high click renders inside its scheduled frame window", async ({ page }) => {
  const rendered = await page.evaluate(async ({ sampleRate, when }) => {
    const { CLICK_ENVELOPE, SOUND_PROFILES, scheduleClickVoice } = await import(
      "/metronome.js"
    );
    const context = new OfflineAudioContext(1, sampleRate / 10, sampleRate);

    scheduleClickVoice(context, context.destination, {
      sound: "high",
      level: 1,
      when,
    });
    const buffer = await context.startRendering();
    const samples = buffer.getChannelData(0);
    const audible = (sample) => Math.abs(sample) > 1e-7;
    const first = samples.findIndex(audible);
    let last = samples.length - 1;
    while (last >= 0 && !audible(samples[last])) last -= 1;

    return {
      first,
      last,
      startFrame: Math.round(when * sampleRate),
      stopFrame: Math.round(
        (when + SOUND_PROFILES.high.length + CLICK_ENVELOPE.releaseSeconds)
        * sampleRate,
      ),
    };
  }, { sampleRate: SAMPLE_RATE, when: WHEN });

  expect(rendered.first).toBeGreaterThanOrEqual(rendered.startFrame);
  expect(rendered.first).toBeLessThanOrEqual(rendered.startFrame + 2);
  expect(rendered.last).toBeLessThan(rendered.stopFrame);
  expect(rendered.last).toBeGreaterThan(rendered.stopFrame - 4);
});

test("step levels scale the click amplitude and off stays silent", async ({ page }) => {
  const rendered = await page.evaluate(async ({ sampleRate, when }) => {
    const { CLICK_ENVELOPE, scheduleClickVoice } = await import(
      "/metronome.js"
    );
    const attackFrame = Math.round(
      (when + CLICK_ENVELOPE.attackSeconds) * sampleRate,
    );

    async function render(level) {
      const context = new OfflineAudioContext(1, sampleRate / 10, sampleRate);
      const source = scheduleClickVoice(context, context.destination, {
        sound: "high",
        level,
        when,
      });
      const buffer = await context.startRendering();
      const samples = buffer.getChannelData(0);

      return {
        atAttackPeak: Math.abs(samples[attackFrame]),
        peak: samples.reduce(
          (maximum, sample) => Math.max(maximum, Math.abs(sample)),
          0,
        ),
        ceiling: CLICK_ENVELOPE.peakGain * level,
        scheduled: source !== null,
      };
    }

    return Promise.all([0, 0.25, 0.5, 1].map(render));
  }, { sampleRate: SAMPLE_RATE, when: WHEN });

  const [off, quarter, half, full] = rendered;
  expect(off).toMatchObject({ peak: 0, scheduled: false });
  expect(full.scheduled).toBe(true);
  expect(quarter.atAttackPeak / full.atAttackPeak).toBeCloseTo(0.25, 4);
  expect(half.atAttackPeak / full.atAttackPeak).toBeCloseTo(0.5, 4);

  for (const step of [quarter, half, full]) {
    expect(step.peak).toBeGreaterThan(0);
    expect(step.peak).toBeLessThanOrEqual(step.ceiling);
  }
});

test("a muted layer output renders silence from its first frame", async ({ page }) => {
  const peaks = await page.evaluate(async ({ sampleRate, when }) => {
    const { createLayerOutput, scheduleClickVoice } = await import(
      "/metronome.js"
    );

    async function render(muted) {
      const context = new OfflineAudioContext(1, sampleRate / 10, sampleRate);
      const { gain } = createLayerOutput(context, context.destination, {
        volume: 1,
        pan: 0,
        muted,
      });
      scheduleClickVoice(context, gain, { sound: "high", level: 1, when });
      const buffer = await context.startRendering();

      return buffer
        .getChannelData(0)
        .reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
    }

    return Promise.all([true, false].map(render));
  }, { sampleRate: SAMPLE_RATE, when: WHEN });

  const [muted, unmuted] = peaks;
  expect(muted).toBe(0);
  expect(unmuted).toBeGreaterThan(0);
});

test("layer panning separates the rendered stereo channels", async ({ page }) => {
  const renders = await page.evaluate(async ({ sampleRate, when }) => {
    const { createLayerOutput, scheduleClickVoice } = await import(
      "/metronome.js"
    );

    async function render(pan) {
      const context = new OfflineAudioContext(2, sampleRate / 10, sampleRate);
      const { gain } = createLayerOutput(context, context.destination, {
        volume: 1,
        pan,
        muted: false,
      });
      scheduleClickVoice(context, gain, { sound: "high", level: 1, when });
      const buffer = await context.startRendering();

      return [0, 1].map((channel) =>
        buffer
          .getChannelData(channel)
          .reduce((energy, sample) => energy + sample * sample, 0),
      );
    }

    return Promise.all([-1, 0, 1].map(render));
  }, { sampleRate: SAMPLE_RATE, when: WHEN });

  const [hardLeft, center, hardRight] = renders;
  expect(hardLeft[1]).toBeLessThan(hardLeft[0] * 0.001);
  expect(center[0] / center[1]).toBeCloseTo(1, 2);
  expect(hardRight[0]).toBeLessThan(hardRight[1] * 0.001);
});
