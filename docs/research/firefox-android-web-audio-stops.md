# Mobile browsers: Web Audio stopping during a run

> **Scope:** whether a Web Audio metronome can stop after running for a while on
> Firefox for Android, whether related failures exist in other mobile browsers,
> and what a web application can do about them. Researched
> 2026-08-06 from Mozilla Bugzilla and source documentation, MDN, the Web Audio
> specification, and Android documentation. The report did not say whether the
> page was foregrounded, the screen was locked, or another audio source
> interrupted it, so those cases are kept separate.

## Conclusion

**Yes, this is a known class of Firefox for Android failure, but the symptom by
itself does not identify one cause.** The strongest current match is loss of
Android audio focus — for example an alarm, call, assistant, another app
starting audio, or an output-device change. Mozilla found that Firefox for
Android did not route system focus loss and gain through its new Web Audio
interruption path. [Bug 2048732](https://bugzilla.mozilla.org/show_bug.cgi?id=2048732)
is `RESOLVED FIXED`, was fixed on 2026-07-29, and has target milestone `155
Branch` / status `firefox155: fixed`. The fix is not in the current Firefox 153
release ([Mozilla's Firefox 153 release note](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/153));
Firefox 155 is currently the Nightly line
([Mozilla's Firefox 155 release note](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/155)).
It is therefore useful to test the same device in a Nightly 155 build containing
the fix.

A second, lower-level Android audio-output failure remains assigned as
[Bug 1837859](https://bugzilla.mozilla.org/show_bug.cgi?id=1837859). An alarm or
Bluetooth disconnect can leave Firefox audio broken across tabs until Firefox
is force-stopped; Mozilla's captured profile shows its AAudio/cubeb stream
stopping and failing to recover timing information. This report covers media
playback generally rather than proving the same path for Polynome's Web Audio,
so it is a plausible match only when the failure follows an alarm or device
change.

If Polynome stays visible and no call, alarm, competing audio, or device change
occurred, this research found **no primary-source bug that conclusively matches
an otherwise spontaneous Web Audio stop**. Capturing context state and clock
progress is the next step in that case.

## Related failures in other browsers

This is not unique to Firefox. The common failure boundary is the hand-off
between a browser's Web Audio graph and the operating system's audio session
after an interruption, route change, or process lifecycle transition.

### Safari and other WebKit clients on iOS

WebKit has several still-open reports that map directly to the defensive cases
Polynome should handle:

- [WebKit Bug 263627](https://bugs.webkit.org/show_bug.cgi?id=263627) reports
  that returning an iOS page to the foreground can leave an `AudioContext`
  claiming `running` while `currentTime` is frozen. A programmatic
  suspend/resume recovered at least some reproductions.
- [WebKit Bug 276016](https://bugs.webkit.org/show_bug.cgi?id=276016) reports
  silence after Safari loses and regains focus, including a frozen clock while
  the context says `running`. Reported workarounds are suspend/resume after
  foregrounding or, if that fails, rebuilding the context. The bug is still
  `NEW`.
- [WebKit Bug 281566](https://bugs.webkit.org/show_bug.cgi?id=281566) reports a
  different failure: `resume()` never resolves after the browser returns from
  the background. Recovery code therefore must not await that promise without
  a deadline or use one pending-promise flag as a permanent gate.
- [WebKit Bug 276687](https://bugs.webkit.org/show_bug.cgi?id=276687) reports
  Web Audio becoming silent after another audio tab closes. Depending on the
  reproduction, `currentTime` either freezes or continues while no sound
  reaches the speaker, so neither `state === "running"` nor an advancing clock
  proves physical output.
- Home-screen apps have an additional open failure where Web Audio stays silent
  after returning from the background even when `resume()` is called from a
  tap ([WebKit Bug 291892](https://bugs.webkit.org/show_bug.cgi?id=291892)).

Safari 16.4 introduced a subset of the Audio Session API
([WebKit's Safari 16.4 notes](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)).
Setting `navigator.audioSession.type = "playback"` is WebKit's recommended
mitigation for Web Audio being treated as ambient audio and muted by iOS's
silent switch ([WebKit Bug 251532](https://bugs.webkit.org/show_bug.cgi?id=251532)).
Polynome already claims that type only while playing. It is not a complete
interruption-recovery mechanism, and a playback session may interrupt other
non-mixable device audio, so it should remain scoped to an active run.

### Chrome and Chromium on Android

Chrome 136 shipped the standard `interrupted` state on Android and WebView for
operating-system interruptions. A context that was running is automatically
returned to `running` when the interruption ends; a `resume()` request made
during the interruption is refused
([Chromium intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/iNj-OIZ1T3Q),
[current Blink implementation](https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/modules/webaudio/audio_context.cc)).
This is different from an audio-device or renderer error: Chromium emits an
`error` event, stops rendering, and changes the context to `suspended`. The Web
Audio specification explicitly identifies output-device disconnection and OS
audio malfunction as examples of that error path
([Web Audio error handling](https://webaudio.github.io/web-audio-api/#error-handling-on-a-running-audio-context)).

Defense therefore needs both `statechange` **and** `error`; treating every
silence as an ordinary suspension misses the strongest device-error signal.
Chromium's Android focus handling is still evolving—for example, it added
delayed focus gain after phone calls in June 2026
([Chromium media change](https://chromium.googlesource.com/chromium/src/media/+/6c2558f12ab2ff827b000d7fffa7d344bcbe1820)).

Chrome can also freeze or discard background pages as the OS or browser reclaims
resources. Frozen pages do not run timers or promise callbacks, and discarded
pages receive no final event; Chrome documents `visibilitychange`, `freeze`,
`resume`, `pagehide`, and `pageshow` as the usable lifecycle boundaries
([Chrome Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)).
Chrome generally exempts pages playing audio from ordinary discard heuristics,
but not from extreme resource pressure. A service worker cannot make a Web
Audio graph survive a discarded renderer.

No current primary-source Chromium report found in this pass matches the same
alarm-specific Firefox defect. That is not evidence that Chromium cannot fail:
its own render-error path and Android's lifecycle rules make the same recovery
layers useful, while the WebKit reports prove those layers must not rely on the
reported state alone.

## Known issues and platform behaviour

| Situation | Evidence and present status | Confidence for this report |
|---|---|---|
| Call, alarm, assistant, another app, or other Android audio-focus change | [Bug 2048732](https://bugzilla.mozilla.org/show_bug.cgi?id=2048732) says GeckoView used a legacy pause/resume path instead of the Web Audio interruption path. Fixed for Firefox 155. | **High** if one of these happened immediately before silence |
| Alarm or Bluetooth/output-device change leaves all Firefox audio broken | [Bug 1837859](https://bugzilla.mozilla.org/show_bug.cgi?id=1837859) is still assigned. Mozilla's profile analysis records an AAudio stream entering an uninitialised state and not recovering useful timing. | **Medium**; it is a Firefox Android output bug, but not a Web-Audio-specific reproducer |
| Screen lock or app/tab backgrounding | Firefox used to suspend a running `AudioContext`; [Bug 1719183](https://bugzilla.mozilla.org/show_bug.cgi?id=1719183) fixed that in Firefox 92 by letting a running context keep the tab awake. The broader [Bug 1682579](https://bugzilla.mozilla.org/show_bug.cgi?id=1682579), “Web Audio API is not working in background,” remains open. Mozilla notes that without browser-owned media notification/lifecycle support, Android may kill the background app. | **High** that backgrounding is a distinct risk; **low** that the Firefox 92 defect explains a current browser |
| Scheduler timers in an inactive tab | Firefox for Android can delay inactive-tab timers to 15 minutes or unload the tab, but Firefox documents an exemption for a tab containing an `AudioContext` ([MDN `setTimeout`](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout#timeouts_in_inactive_tabs)). A running context should therefore protect Polynome's look-ahead timer, but a context Firefox no longer recognises as active may lose that protection. | **Medium**; it is a consequence or amplifier, not the best primary cause |
| Android process lifecycle | Reliable native background playback uses a browser/app-owned foreground media service and notification ([Android background playback](https://developer.android.com/media/media3/session/background-playback)). A webpage cannot create that Android service. | **High**; there is no page-only guarantee of indefinite background survival |

The Web Audio specification permits a user agent to move a context from
`running` to `interrupted` when it loses access to the audio output, and later
restore it ([Web Audio `AudioContextState`](https://webaudio.github.io/web-audio-api/#enumdef-audiocontextstate)). MDN recommends observing `statechange`; a
page can call [`resume()`](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)
for a suspended context, while the browser ultimately controls an external
interruption ([MDN `BaseAudioContext.state`](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state)).

## Workarounds

There is no single guaranteed web workaround. The useful mitigations are:

1. **Recover stateful interruptions.** Keep the user's intent to play separate
   from the browser's momentary context state and listen for `statechange`.
   Initially wait out `interrupted`, because conforming browsers restore a
   previously running context automatically; resume a `suspended` context when
   the page is visible. Safari's stuck-interruption bugs justify a bounded retry
   after foregrounding, but not an unbounded resume loop.
2. **Use lifecycle edges as health checks.** When `visibilitychange` becomes
   visible, `pageshow`, Page Lifecycle `resume`, or window focus fires, verify
   the context instead of assuming `statechange` was delivered while the
   process slept.
3. **Listen for render errors.** Feature-detect `AudioContext`'s `error` event.
   In Chromium it means the audio device or renderer failed and the context was
   moved to `suspended`, which is a strong signal for rebuilding it
   ([Chromium's Web Audio error intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/B0t-BZzs8s4/m/gFw9tmHxAwAJ)).
4. **Watch the audio clock while visible.** Compare successive `currentTime`
   samples against a monotonic wall clock only as a health check, never as the
   beat clock. Require several stalled samples after a foreground grace period
   to avoid reacting to an ordinary lifecycle transition. If a context says
   `running` but its clock is frozen, try one suspend/resume cycle; this matches
   successful workarounds in the WebKit reports above.
5. **Escalate to a bounded hard recovery.** If resume rejects or does not settle
   by a deadline, the clock remains stalled after suspend/resume, the context
   emits `error`, or it is `closed`, detach and discard it and rebuild the
   graph. Do not await `close()` indefinitely. Serialize recovery and attach a
   generation token so late promises or events from the old context cannot
   mutate its replacement. Prefer rebuilding while visible and under a user
   tap; autoplay policy can refuse an automatic replacement.
6. **Always provide a manual Restart Audio action.** A context may say `running`
   and advance its clock while the physical output remains silent. Web Audio
   cannot observe sound after it leaves the graph, so no automatic watchdog can
   prove that case. A user-triggered rebuild is the final page-level escape
   hatch.
7. **Keep timing derived from the audio clock.** A delayed JavaScript timer may
   feed the scheduler late, but it must never become the musical clock. On
   recovery, cancel stale sources, re-anchor from the recovered context's
   `currentTime`, and skip missed clicks rather than producing a catch-up burst.
8. **Optionally prevent screen lock.** An opt-in
   [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
   while playing avoids the lock-screen path, but it is released when the page
   becomes hidden, costs battery, and is not a background-playback solution.
9. **For affected users now:** keep Firefox and the page foregrounded, disable
   battery optimisation for Firefox as a diagnostic rather than a promised
   fix, avoid competing audio/output changes during a run, and try Firefox
   Nightly 155. If an alarm or Bluetooth change breaks all Firefox audio,
   force-stopping and reopening Firefox is the documented practical recovery
   in the open Mozilla report.

## Polynome implications

Polynome implements the recoverable measures in `metronome.ts`: it observes
context state and render errors, treats foreground lifecycle signals as health
checks, detects a positively stalled audio clock, and places application-owned
deadlines around recovery promises. A visible suspended context receives one
resume attempt; WebKit's false-`running` case receives one suspend/resume cycle
and a second clock check. A failed attempt, closed context, render error, or
explicit Restart Audio action replaces the context and starts a fresh Transport
run. Replacement is serialized and identity-guarded so late events and promises
from the abandoned context cannot affect its successor.

Bug 2048732 may still be below the application layer: more calls to `resume()`
cannot repair a Firefox audio-focus path that failed to return the underlying
stream. Likewise, no page can guarantee survival after Android kills the
browser, nor detect silence beyond the Web Audio graph when state and clock both
look healthy. The manual Restart Audio action is the final page-level escape
hatch for that case. Rebuilding on every visibility change would discard
transport unnecessarily and would not solve either platform limitation.

## Diagnostic checklist

Record these on the affected device before choosing a code change:

1. Firefox channel and exact version, Android version, device model, wired /
   Bluetooth / speaker output, and battery-optimisation setting.
2. Whether Firefox, the tab, and the screen were foreground/visible/on when the
   stop happened.
3. Whether an alarm, notification sound, call, assistant, another audio app, or
   output-device connect/disconnect immediately preceded it.
4. At each `statechange`, log `AudioContext.state`, `currentTime`, document
   visibility, and whether Polynome intends to be playing. While silent, sample
   whether `currentTime` continues to advance and whether scheduler ticks still
   run.
5. Compare release Firefox with Nightly 155. If Nightly alone recovers from the
   same focus interruption, [Bug 2048732](https://bugzilla.mozilla.org/show_bug.cgi?id=2048732)
   is the likely cause.
6. If the context remains `running` and its clock advances but no sound reaches
   the device, or if all Firefox tabs lose audio, capture Firefox's **Media
   Playback** log/profile and attach a reduced reproduction to Bugzilla. Mozilla
   documents Android remote inspection through
   [`about:debugging`](https://firefox-source-docs.mozilla.org/devtools-user/about_colon_debugging/index.html).
