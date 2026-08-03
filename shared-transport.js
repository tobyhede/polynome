import { cycleSpanSeconds, stepDurationSeconds, stepLevel } from "./model.js";

/**
 * The planning side of the two lateness policies this metronome runs.
 *
 * `plan()` refuses to emit any event more than this far behind the clock it is
 * given, so a caller never receives an event it could not still commit on time.
 * At 4 ms that is roughly a couple of hundred frames at 48 kHz: below audible
 * displacement, and deliberately far stricter than the engine's own guard.
 *
 * The engine's `MAX_CLICK_LATENESS_SECONDS` in `metronome.js` is the committing
 * side, and it is an order of magnitude looser. The two are not in competition
 * and the difference is not an oversight: this one is measured when an event is
 * planned, that one when it is committed, and the render clock moves between
 * those two moments. Everything `plan()` emits starts out within 4 ms; only the
 * clock advancing mid-tick can push a click past the engine's threshold, which
 * is the only reason that threshold is reachable at all. Tightening this
 * tolerance therefore does not make the engine's guard redundant, and loosening
 * it would hand the engine events it has already decided are not worth sounding.
 */
const LATENESS_TOLERANCE_SECONDS = 0.004;

export class SharedTransport {
  #origin = 0;
  #schedulingPosition = 0;
  #timing = null;

  get origin() {
    return this.#origin;
  }

  start({ bpm, sequence }, origin) {
    this.#origin = origin;
    this.#schedulingPosition = origin;
    const sourceCycles = sequence.cycles
      .filter((cycle) => cycle.repetitions > 0);
    if (!sourceCycles.length) {
      this.#timing = null;
      return;
    }
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

  updateStepLevels({ sequence }) {
    if (!this.#timing) return;
    const sourceRhythms = sequence.cycles
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
