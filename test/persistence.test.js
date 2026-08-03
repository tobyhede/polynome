import test from "node:test";
import assert from "node:assert/strict";

import { createPersistence } from "../persistence.js";

const createTimers = () => {
  const scheduled = new Map();
  let nextTimer = 1;
  return {
    setTimer(callback, delay) {
      const timer = nextTimer++;
      scheduled.set(timer, { callback, delay });
      return timer;
    },
    clearTimer(timer) {
      scheduled.delete(timer);
    },
    elapse() {
      const due = [...scheduled.values()];
      scheduled.clear();
      for (const { callback } of due) callback();
    },
    get delays() {
      return [...scheduled.values()].map(({ delay }) => delay);
    },
  };
};

const createRecorder = () => {
  const written = [];
  return { written, write: (value) => written.push(value) };
};

test("rapid edits collapse into one deferred write carrying the latest value", () => {
  const timers = createTimers();
  const recorder = createRecorder();
  const persistence = createPersistence({
    write: recorder.write,
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  persistence.schedule({ bpm: 120 });
  persistence.schedule({ bpm: 121 });
  persistence.schedule({ bpm: 122 });

  assert.deepEqual(recorder.written, []);
  assert.deepEqual(timers.delays, [400]);

  timers.elapse();

  assert.deepEqual(recorder.written, [{ bpm: 122 }]);
});

test("flushing writes the pending value immediately and cancels the deferred write", () => {
  const timers = createTimers();
  const recorder = createRecorder();
  const persistence = createPersistence({
    write: recorder.write,
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  persistence.schedule({ bpm: 140 });

  assert.deepEqual(recorder.written, []);

  persistence.flush();

  assert.deepEqual(recorder.written, [{ bpm: 140 }]);
  assert.deepEqual(timers.delays, []);

  timers.elapse();

  assert.deepEqual(recorder.written, [{ bpm: 140 }]);
});

test("flushing without a pending value writes nothing", () => {
  const timers = createTimers();
  const recorder = createRecorder();
  const persistence = createPersistence({
    write: recorder.write,
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  persistence.flush();

  assert.deepEqual(recorder.written, []);

  persistence.schedule({ bpm: 90 });

  assert.deepEqual(recorder.written, []);

  timers.elapse();
  persistence.flush();

  assert.deepEqual(recorder.written, [{ bpm: 90 }]);
});

test("a write that throws does not reach the caller", () => {
  const timers = createTimers();
  const failure = () => {
    throw new Error("storage is unavailable");
  };
  const persistence = createPersistence({
    write: failure,
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  persistence.schedule({ bpm: 60 });
  assert.doesNotThrow(() => timers.elapse());

  persistence.schedule({ bpm: 61 });
  assert.doesNotThrow(() => persistence.flush());
});

test("each editing burst gets its own deferred write", () => {
  const timers = createTimers();
  const recorder = createRecorder();
  const persistence = createPersistence({
    write: recorder.write,
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  persistence.schedule({ bpm: 100 });
  timers.elapse();
  persistence.schedule({ bpm: 101 });
  persistence.schedule({ bpm: 102 });
  timers.elapse();

  assert.deepEqual(recorder.written, [{ bpm: 100 }, { bpm: 102 }]);
});
