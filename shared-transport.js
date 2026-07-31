import { STEP, stepDurationSeconds } from "./model.js";

const LATENESS_TOLERANCE_SECONDS = 0.004;

export class SharedTransport {
  #origin = 0;
  #schedulingPosition = 0;
  #timing = null;

  get origin() {
    return this.#origin;
  }

  start({ bpm, layers }, origin) {
    this.#origin = origin;
    this.#schedulingPosition = origin;
    this.#timing = {
      bpm,
      layers: layers.map((layer) => ({
        id: layer.id,
        signature: { ...layer.signature },
        subdivision: layer.subdivision,
        steps: [...layer.steps],
      })),
    };
  }

  plan(currentTime, horizon) {
    if (!this.#timing || horizon <= this.#schedulingPosition) return [];

    const events = [];
    const fromTime = this.#schedulingPosition;
    const candidateFromTime = Math.max(
      fromTime,
      currentTime - LATENESS_TOLERANCE_SECONDS,
    );

    for (const layer of this.#timing.layers) {
      const duration = stepDurationSeconds(this.#timing.bpm, layer);
      const firstAbsoluteStep = Math.max(
        0,
        Math.floor((candidateFromTime - this.#origin) / duration),
      );
      const finalAbsoluteStep = Math.ceil(
        (horizon - this.#origin) / duration,
      );

      for (
        let absoluteStep = firstAbsoluteStep;
        absoluteStep <= finalAbsoluteStep;
        absoluteStep += 1
      ) {
        const patternPosition = absoluteStep % layer.steps.length;
        const strength = layer.steps[patternPosition];
        const audioTime = this.#origin + absoluteStep * duration;
        if (
          strength === STEP.REST ||
          audioTime < fromTime ||
          audioTime >= horizon ||
          audioTime < currentTime - LATENESS_TOLERANCE_SECONDS
        ) {
          continue;
        }

        events.push({
          layerId: layer.id,
          absoluteStep,
          patternPosition,
          strength,
          audioTime,
        });
      }
    }

    this.#schedulingPosition = horizon;
    return events.sort((left, right) => {
      if (left.audioTime !== right.audioTime) {
        return left.audioTime - right.audioTime;
      }
      return left.layerId.localeCompare(right.layerId);
    });
  }

  patternPosition(layerId, currentTime) {
    const layer = this.#timing?.layers.find(
      (candidate) => candidate.id === layerId,
    );
    if (!layer) return null;
    if (currentTime < this.#origin) return 0;

    const duration = stepDurationSeconds(this.#timing.bpm, layer);
    let absoluteStep = Math.floor((currentTime - this.#origin) / duration);

    while (
      this.#origin + (absoluteStep + 1) * duration <= currentTime
    ) {
      absoluteStep += 1;
    }
    while (
      absoluteStep > 0 &&
      this.#origin + absoluteStep * duration > currentTime
    ) {
      absoluteStep -= 1;
    }

    return absoluteStep % layer.steps.length;
  }
}
