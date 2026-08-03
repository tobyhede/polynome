import test from "node:test";
import assert from "node:assert/strict";

import { createPersistence, readStoredValue } from "../persistence.js";

const createStorage = (entries = {}) => {
  const items = new Map(Object.entries(entries));
  return {
    get keys() {
      return [...items.keys()].sort();
    },
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
};

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

/**
 * A scheduled `null` or `undefined` is a value the caller asked to store, not
 * an absence of one, so neither may be mistaken for having nothing pending.
 */
test("a scheduled nullish value is written like any other", () => {
  const timers = createTimers();
  const recorder = createRecorder();
  const persistence = createPersistence({
    write: recorder.write,
    delay: 400,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  persistence.schedule(null);
  timers.elapse();

  assert.deepEqual(recorder.written, [null]);

  persistence.schedule(undefined);
  persistence.flush();

  assert.deepEqual(recorder.written, [null, undefined]);
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

/**
 * Renaming the storage key would silently reset every existing user, so the
 * value stored under the previous name is adopted once and then the old name
 * is cleared. Retired names carry shapes this version cannot read and are only
 * ever discarded.
 */
test("a stored value is adopted from the previous key name", () => {
  const storage = createStorage({ "polynome-redesign": '{"bpm":132}' });

  const raw = readStoredValue({
    storage,
    key: "polynome-configuration",
    supersededKeys: ["polynome-redesign"],
  });

  assert.equal(raw, '{"bpm":132}');
  assert.equal(storage.getItem("polynome-configuration"), '{"bpm":132}');
  assert.deepEqual(storage.keys, ["polynome-configuration"]);
});

test("the current key wins and the superseded one is cleared", () => {
  const storage = createStorage({
    "polynome-configuration": '{"bpm":90}',
    "polynome-redesign": '{"bpm":132}',
  });

  const raw = readStoredValue({
    storage,
    key: "polynome-configuration",
    supersededKeys: ["polynome-redesign"],
  });

  assert.equal(raw, '{"bpm":90}');
  assert.deepEqual(storage.keys, ["polynome-configuration"]);
});

test("retired keys are discarded rather than adopted", () => {
  const storage = createStorage({
    "polynome:v1": '{"bpm":200}',
    "polynome-meter": "4/4",
  });

  const raw = readStoredValue({
    storage,
    key: "polynome-configuration",
    retiredKeys: ["polynome:v1", "polynome-meter"],
  });

  assert.equal(raw, null);
  assert.deepEqual(storage.keys, []);
});

test("nothing stored reads as null without writing", () => {
  const storage = createStorage();

  const raw = readStoredValue({
    storage,
    key: "polynome-configuration",
    supersededKeys: ["polynome-redesign"],
  });

  assert.equal(raw, null);
  assert.deepEqual(storage.keys, []);
});

/**
 * Safari in private browsing throws from every storage method. Losing stored
 * settings is acceptable there; failing to start is not.
 */
test("a storage that throws reads as null", () => {
  const unavailable = {
    getItem() {
      throw new Error("storage is unavailable");
    },
    setItem() {
      throw new Error("storage is unavailable");
    },
    removeItem() {
      throw new Error("storage is unavailable");
    },
  };

  let raw;
  assert.doesNotThrow(() => {
    raw = readStoredValue({
      storage: unavailable,
      key: "polynome-configuration",
      supersededKeys: ["polynome-redesign"],
      retiredKeys: ["polynome:v1"],
    });
  });
  assert.equal(raw, null);
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
