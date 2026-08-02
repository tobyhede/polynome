import { cycleSpanSeconds, stepDurationSeconds, stepLevel } from "./model.js";

const LATENESS_TOLERANCE_SECONDS = 0.004;

export class SharedTransport {
  #origin = 0;
  #schedulingPosition = 0;
  #timing = null;

  get origin() {
    return this.#origin;
  }

  start({ bpm, cycles, layers }, origin) {
    this.#origin = origin;
    this.#schedulingPosition = origin;
    const sourceCycles = (
      cycles || [{ id: "cycle", repetitions: 1, rhythms: layers }]
    ).filter((cycle) => cycle.repetitions > 0);
    let offset = 0;
    const timingCycles = sourceCycles.map((cycle) => {
      const rhythms = cycle.rhythms.map((rhythm) => ({
        id: rhythm.id,
        signature: { ...rhythm.signature },
        subdivision: rhythm.subdivision,
        steps: [...rhythm.steps],
      }));
      const span = cycleSpanSeconds(bpm, { rhythms });
      const timingCycle = {
        id: cycle.id,
        repetitions: cycle.repetitions,
        rhythms,
        span,
        offset,
      };
      offset += span * cycle.repetitions;
      return timingCycle;
    });

    this.#timing = {
      bpm,
      cycles: timingCycles,
      sequenceDuration: offset,
    };
  }

  updateStepLevels({ cycles, layers }) {
    if (!this.#timing) return;
    const sourceRhythms = (cycles || [{ rhythms: layers }])
      .flatMap((cycle) => cycle.rhythms || []);
    const stepsByRhythm = new Map(
      sourceRhythms.map((rhythm) => [rhythm.id, rhythm.steps]),
    );

    for (const cycle of this.#timing.cycles) {
      for (const rhythm of cycle.rhythms) {
        const steps = stepsByRhythm.get(rhythm.id);
        if (Array.isArray(steps) && steps.length === rhythm.steps.length) {
          rhythm.steps = [...steps];
        }
      }
    }
  }

  plan(currentTime, horizon) {
    if (!this.#timing || horizon <= this.#schedulingPosition) return [];

    const events = [];
    const fromTime = this.#schedulingPosition;
    const candidateFromTime = Math.max(
      fromTime,
      currentTime - LATENESS_TOLERANCE_SECONDS,
    );
    const { bpm, cycles, sequenceDuration } = this.#timing;
    const firstSequence = Math.max(
      0,
      Math.floor((candidateFromTime - this.#origin) / sequenceDuration),
    );
    const finalSequence = Math.max(
      firstSequence,
      Math.ceil((horizon - this.#origin) / sequenceDuration),
    );

    for (
      let sequenceIndex = firstSequence;
      sequenceIndex <= finalSequence;
      sequenceIndex += 1
    ) {
      const sequenceOrigin = this.#origin + sequenceIndex * sequenceDuration;

      for (const cycle of cycles) {
        for (
          let repetitionIndex = 0;
          repetitionIndex < cycle.repetitions;
          repetitionIndex += 1
        ) {
          const repetitionOrigin = sequenceOrigin
            + cycle.offset
            + repetitionIndex * cycle.span;
          if (repetitionOrigin >= horizon) continue;
          if (repetitionOrigin + cycle.span < candidateFromTime) continue;

          for (const rhythm of cycle.rhythms) {
            const duration = stepDurationSeconds(bpm, rhythm);
            const stepsPerSpan = Math.round(cycle.span / duration);
            const firstStep = Math.max(
              0,
              Math.floor((candidateFromTime - repetitionOrigin) / duration),
            );

            for (
              let localStep = firstStep;
              localStep < stepsPerSpan;
              localStep += 1
            ) {
              const audioTime = repetitionOrigin + localStep * duration;
              if (audioTime >= horizon) break;
              const patternPosition = localStep % rhythm.steps.length;
              const level = stepLevel(rhythm.steps[patternPosition]);
              if (
                level === 0
                || audioTime < fromTime
                || audioTime < currentTime - LATENESS_TOLERANCE_SECONDS
              ) {
                continue;
              }

              events.push({
                layerId: rhythm.id,
                absoluteStep: (
                  (sequenceIndex * cycle.repetitions + repetitionIndex)
                  * stepsPerSpan
                  + localStep
                ),
                patternPosition,
                level,
                audioTime,
              });
            }
          }
        }
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

  position(currentTime) {
    if (!this.#timing) return null;
    if (currentTime < this.#origin) {
      return { cycleId: this.#timing.cycles[0].id, cycleIndex: 0, repetitionIndex: 0 };
    }

    const elapsed = (currentTime - this.#origin) % this.#timing.sequenceDuration;
    for (let cycleIndex = 0; cycleIndex < this.#timing.cycles.length; cycleIndex += 1) {
      const cycle = this.#timing.cycles[cycleIndex];
      const cycleDuration = cycle.span * cycle.repetitions;
      if (elapsed < cycle.offset + cycleDuration) {
        return {
          cycleId: cycle.id,
          cycleIndex,
          repetitionIndex: Math.floor((elapsed - cycle.offset) / cycle.span),
        };
      }
    }

    return { cycleId: this.#timing.cycles[0].id, cycleIndex: 0, repetitionIndex: 0 };
  }

  patternPosition(layerId, currentTime) {
    if (!this.#timing) return null;
    const position = this.position(currentTime);
    const cycle = this.#timing.cycles[position.cycleIndex];
    const rhythm = cycle.rhythms.find((candidate) => candidate.id === layerId);
    if (!rhythm) return null;
    if (currentTime < this.#origin) return 0;

    const sequenceIndex = Math.floor(
      (currentTime - this.#origin) / this.#timing.sequenceDuration,
    );
    const repetitionOrigin = this.#origin
      + sequenceIndex * this.#timing.sequenceDuration
      + cycle.offset
      + position.repetitionIndex * cycle.span;
    const elapsed = currentTime - repetitionOrigin;
    const duration = stepDurationSeconds(this.#timing.bpm, rhythm);
    let absoluteStep = Math.floor(elapsed / duration);

    while (repetitionOrigin + (absoluteStep + 1) * duration <= currentTime) {
      absoluteStep += 1;
    }
    while (
      absoluteStep > 0
      && repetitionOrigin + absoluteStep * duration > currentTime
    ) {
      absoluteStep -= 1;
    }

    return absoluteStep % rhythm.steps.length;
  }
}
