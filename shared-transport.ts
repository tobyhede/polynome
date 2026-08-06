import {
  STEP,
  beatAtSeconds,
  createSequenceTempoCurves,
  secondsAtBeat,
  tempoAtBeat,
} from "./model.ts";

/**
 * The planning side of the two lateness policies this metronome runs.
 *
 * `plan()` refuses to emit any event more than this far behind the clock it is
 * given, so a caller never receives an event it could not still commit on time.
 * At 4 ms that is roughly a couple of hundred frames at 48 kHz: below audible
 * displacement, and deliberately far stricter than the engine's own guard.
 *
 * The engine's `MAX_CLICK_LATENESS_SECONDS` in `metronome.ts` is the committing
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
    const sourceCycles = sequence.cycles.filter((cycle) => cycle.repetitions > 0);
    if (!sourceCycles.length) {
      this.#timing = null;
      return;
    }
    let offset = 0;
    const tempoCycles = createSequenceTempoCurves(bpm, sourceCycles);
    const timingCycles = sourceCycles.map((cycle, cycleIndex) => {
      const rhythms = cycle.rhythms.map((rhythm) => ({
        id: rhythm.id,
        signature: { ...rhythm.signature },
        subdivision: rhythm.subdivision,
        steps: [...rhythm.steps],
      }));
      const { beatLength, curve } = tempoCycles[cycleIndex];
      const spanBeats = beatLength / cycle.repetitions;
      const duration = secondsAtBeat(curve, beatLength);
      const timingCycle = {
        id: cycle.id,
        repetitions: cycle.repetitions,
        rhythms,
        spanBeats,
        curve,
        duration,
        offset,
      };
      offset += duration;
      return timingCycle;
    });

    this.#timing = {
      bpm,
      cycles: timingCycles,
      sequenceDuration: offset,
    };
  }

  updateStepVoices({ sequence }) {
    if (!this.#timing) return;
    const sourceRhythms = sequence.cycles.flatMap((cycle) => cycle.rhythms || []);
    const stepsByRhythm = new Map(sourceRhythms.map((rhythm) => [rhythm.id, rhythm.steps]));

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
    const candidateFromTime = Math.max(fromTime, currentTime - LATENESS_TOLERANCE_SECONDS);
    const { cycles, sequenceDuration } = this.#timing;
    const firstSequence = Math.max(
      0,
      Math.floor((candidateFromTime - this.#origin) / sequenceDuration),
    );
    const finalSequence = Math.max(
      firstSequence,
      Math.ceil((horizon - this.#origin) / sequenceDuration),
    );

    for (let sequenceIndex = firstSequence; sequenceIndex <= finalSequence; sequenceIndex += 1) {
      const sequenceOrigin = this.#origin + sequenceIndex * sequenceDuration;

      for (const cycle of cycles) {
        const cycleOrigin = sequenceOrigin + cycle.offset;
        if (cycleOrigin >= horizon) continue;
        if (cycleOrigin + cycle.duration < candidateFromTime) continue;

        for (const rhythm of cycle.rhythms) {
          const stepsPerSpan = cycle.spanBeats * rhythm.subdivision;
          const totalSteps = stepsPerSpan * cycle.repetitions;
          const elapsedCandidate = Math.max(0, candidateFromTime - cycleOrigin);
          const candidateBeat = beatAtSeconds(cycle.curve, elapsedCandidate);
          const firstStep = Math.max(0, Math.floor(candidateBeat * rhythm.subdivision));

          for (let cycleStep = firstStep; cycleStep < totalSteps; cycleStep += 1) {
            const musicalBeat = cycleStep / rhythm.subdivision;
            const audioTime = cycleOrigin + secondsAtBeat(cycle.curve, musicalBeat);
            if (audioTime >= horizon) break;
            const repetition = Math.floor(cycleStep / stepsPerSpan);
            const localStep = cycleStep % stepsPerSpan;
            const patternPosition = localStep % rhythm.steps.length;
            const voice = rhythm.steps[patternPosition];
            if (
              voice === STEP.OFF ||
              audioTime < fromTime ||
              audioTime < currentTime - LATENESS_TOLERANCE_SECONDS
            ) {
              continue;
            }

            events.push({
              layerId: rhythm.id,
              absoluteStep:
                (sequenceIndex * cycle.repetitions + repetition) * stepsPerSpan + localStep,
              patternPosition,
              musicalBeat,
              voice,
              audioTime,
            });
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
      const cycleDuration = cycle.duration;
      if (elapsed < cycle.offset + cycleDuration) {
        const cycleBeat = beatAtSeconds(cycle.curve, elapsed - cycle.offset);
        return {
          cycleId: cycle.id,
          cycleIndex,
          repetitionIndex: Math.min(cycle.repetitions - 1, Math.floor(cycleBeat / cycle.spanBeats)),
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

    const sequenceIndex = Math.floor((currentTime - this.#origin) / this.#timing.sequenceDuration);
    const cycleOrigin = this.#origin + sequenceIndex * this.#timing.sequenceDuration + cycle.offset;
    const cycleBeat = beatAtSeconds(cycle.curve, currentTime - cycleOrigin);
    let absoluteStep = Math.floor(cycleBeat * rhythm.subdivision);

    while (
      cycleOrigin + secondsAtBeat(cycle.curve, (absoluteStep + 1) / rhythm.subdivision) <=
      currentTime
    ) {
      absoluteStep += 1;
    }
    while (
      absoluteStep > 0 &&
      cycleOrigin + secondsAtBeat(cycle.curve, absoluteStep / rhythm.subdivision) > currentTime
    ) {
      absoluteStep -= 1;
    }

    return absoluteStep % rhythm.steps.length;
  }

  currentBpm(currentTime, musicalBeat = null) {
    if (!this.#timing) return null;
    if (currentTime < this.#origin) return this.#timing.cycles[0].curve.startBpm;
    const elapsed = (currentTime - this.#origin) % this.#timing.sequenceDuration;
    const cycle = this.#timing.cycles.find(
      (candidate) => elapsed < candidate.offset + candidate.duration,
    );
    if (!cycle) return this.#timing.bpm;
    // A planned event already carries the cycle-relative beat its audio time
    // came from. Interface reads omit it and derive the beat from wall time.
    const beat = musicalBeat ?? beatAtSeconds(cycle.curve, elapsed - cycle.offset);
    return tempoAtBeat(cycle.curve, beat);
  }
}
