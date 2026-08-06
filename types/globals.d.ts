/**
 * Two browser APIs this application reaches for on purpose that TypeScript's
 * DOM library does not declare. Neither is a mistake to be fixed in the source:
 * both are load-bearing on Safari, which `docs/research/ios-safari-web-audio.md`
 * covers, and both are already guarded at the call site because they are absent
 * everywhere else.
 *
 * Declaring them optional is what keeps that guard honest. If either were typed
 * as always present, the `if` around it would read as dead code and the checker
 * would stop objecting to removing it.
 */

interface Window {
  /**
   * Safari's prefixed constructor. `metronome.ts` falls back to it when the
   * unprefixed `AudioContext` is missing, which is still the case on older iOS.
   */
  webkitAudioContext?: typeof AudioContext;
}

interface Navigator {
  /**
   * The iOS audio session API, used to tell Safari this is playback rather
   * than ambient sound. Absent on every other engine, and best-effort even
   * where it exists.
   */
  audioSession?: {
    type: string;
  };
}
