# iOS Safari Web Audio: silent, error-free failure

> **Scope:** why a Web Audio metronome that schedules sources against `AudioContext.currentTime` produces no sound and no console errors on iPhone Safari while working on desktop. Sources are the W3C Web Audio API spec, WebKit source and Bugzilla, Apple documentation, and MDN. Every claim carries its source URL; unsourced claims are marked as such.

## Conclusion

Only a small number of mechanisms can produce *completely* silent, *completely* error-free failure. Ranked, they are:

1. **`await ctx.resume()` never settles.** On WebKit, if the context is not allowed to start at the moment `resume()` runs, the returned promise is parked and is *never* resolved *and never rejected*. Any `await` on it deadlocks the rest of the start path, so no scheduler is installed and nothing is ever scheduled ([WebKit `AudioContext::resumeRendering`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp), [spec `resume()` step "If the context is not allowed to start, append promise to `[[pending resume promises]]`"](https://webaudio.github.io/web-audio-api/#dom-audiocontext-resume)).
2. **The context is never allowed to start.** iOS is the only WebKit platform that requires user activation for Web Audio by default, and the gate is *transient activation*, which expires after 5 s and is not granted by `touchstart` ([UnifiedWebPreferences.yaml](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml), [HTML §user activation](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation)). `state` stays `"suspended"`, `currentTime` stays `0`, `start()` silently no-ops.
3. **The Ring/Silent switch.** Web Audio is mapped to the AVAudioSession `Ambient` category, which is silenced by the hardware switch and by screen lock. `<audio>`/`<video>` is mapped to `Playback` and is not. This is by design, is undetectable from JS, and reports `state === "running"` with `currentTime` advancing ([Jer Noble, WebKit bug 252746](https://bugs.webkit.org/show_bug.cgi?id=252746)).
4. **Interruption / backgrounding.** `state` becomes `"interrupted"` (a WebKit state since 2015, only added to the spec in 2025), or — per several open WebKit bugs — stays `"running"` while the render thread is dead.
5. **Clock divergence.** `currentTime` freezes while suspended/interrupted and never catches up to wall clock. A transport origin captured before the context ran, or wall-clock-derived event times, land in the past; `start(t)`+`stop(t+d)` with both in the past is defined by the spec to produce *no sound at all*, with no exception.

Causes 6 (`webkitAudioContext`) and 7 (missing nodes such as `StereoPannerNode`) fail **loudly** with `ReferenceError`/`TypeError` and are therefore ruled out by "no errors". The "silent buffer unlock" idiom (8) has not been required since 2015.

## Why desktop works and iPhone does not

`RequiresUserGestureForAudioPlayback` is `true` only on iOS ([Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)):

```yaml
RequiresUserGestureForAudioPlayback:
  defaultValue:
    WebCore:
      PLATFORM(IOS_FAMILY): true
      default: false
```

`AudioContext::constructCommon()` adds `RequireUserGestureForAudioStartRestriction` only when that preference is set, so **macOS Safari starts Web Audio without any gesture** ([AudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)). Chrome's policy is separate and more permissive (Media Engagement Index plus any prior interaction on the origin, [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay/)). Same code, same spec, different gate — this is the single largest reason desktop is not a useful test of iOS.

---

## 1. User gesture / autoplay requirement

### When is the context created `suspended`?

**Always, on every browser.** The constructor unconditionally sets `[[control thread state]]` to `suspended`, then *separately* sends a control message to start processing "if context is allowed to start" ([spec §1.2.1](https://webaudio.github.io/web-audio-api/#AudioContext-constructors)). The transition to `running` is asynchronous. WebKit's own layout test asserts `context.state is "suspended"` on the line after `new AudioContext()` ([audiocontext-state-interrupted-expected.txt](https://github.com/WebKit/WebKit/blob/main/LayoutTests/webaudio/audiocontext-state-interrupted-expected.txt)).

So `state === "suspended"` immediately after construction is **not** diagnostic of anything. Only `state` some time later is.

### What exactly is the gate on WebKit?

[`AudioContext.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp):

```cpp
static bool shouldDocumentAllowWebAudioToAutoPlay(const Document& document)
{
    if (document.isCapturing())
        return true;
    RefPtr mainDocument = document.mainFrameDocument();
    if (document.quirks().shouldAutoplayWebAudioForArbitraryUserGesture() && mainDocument && mainDocument->hasHadUserInteraction())
        return true;
    RefPtr window = document.window();
    return window && window->hasTransientActivation();
}
```

This is called from `willBeginPlayback()`, which sits in front of `resumeRendering()` (`ctx.resume()`), `startRendering()` and `mayResumePlayback()`.

### Must `resume()` be synchronous inside the handler?

**No — but the widely-repeated "it must be synchronous" claim is nearly right for the wrong reason.** The gate is `LocalDOMWindow::hasTransientActivation()`, a *time window*, not a call-stack property:

```cpp
static constexpr Seconds defaultTransientActivationDuration { 5_s };

bool LocalDOMWindow::hasTransientActivation() const
{
    auto now = MonotonicTime::now();
    return now >= m_lastActivationTimestamp && now < (m_lastActivationTimestamp + transientActivationDuration());
}
```

([Source/WebCore/page/LocalDOMWindow.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/LocalDOMWindow.cpp))

Consequences, all directly from that code:

- An `await` before `resume()` does **not** by itself break the association. Any number of microtasks, and any `await` that settles inside the 5 s window, still sees transient activation.
- An `await` that takes longer than 5 s (a slow `fetch`, a `decodeAudioData` of a large file, an `await` on a promise resolved by a later event) **does** break it.
- Nothing in the Web Audio path calls `consumeTransientActivation()`, so `resume()` does not burn the activation; but other APIs on the page can. `consumeTransientActivation()` sets the last activation timestamp to negative infinity across the whole frame tree ([HTML §consume user activation](https://html.spec.whatwg.org/multipage/interaction.html#consume-user-activation)); creating a new browsing context is one such consumer in WebKit.

### Which events grant activation?

Per HTML, an *activation triggering input event* is a trusted event whose type is `keydown` (excluding Esc/reserved), `mousedown`, `pointerdown` **only when `pointerType` is `"mouse"`**, `pointerup` **only when `pointerType` is not `"mouse"`**, or `touchend` ([HTML §tracking user activation](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation)).

On an iPhone this means:

| Handler | Grants activation on touch? |
|---|---|
| `touchstart` | **No** |
| `pointerdown` | **No** (pointerType is `"touch"`) |
| `touchend` | Yes |
| `pointerup` | Yes |
| `click` | Yes (fires after `touchend`) |

A start button wired to `touchstart` or `pointerdown` for latency reasons is therefore a complete, silent, iPhone-only failure. This is the most commonly self-inflicted version of cause 2.

### What does `resume()`'s promise do when the gesture is lost?

**It hangs. It neither resolves nor rejects.** Both the spec and WebKit agree:

Spec ([`resume()`](https://webaudio.github.io/web-audio-api/#dom-audiocontext-resume)): *"If the context is not allowed to start, append promise to `[[pending promises]]` and `[[pending resume promises]]` and abort these steps, returning promise."*

WebKit ([AudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)):

```cpp
willBeginPlayback([weakThis = WeakPtr { *this }, promise = WTF::move(promise)](bool willBegin) mutable {
    ...
    if (!willBegin) {
        protectedThis->addReaction(State::Running, WTF::move(promise));
        return;
    }
```

`addReaction` parks the promise until the context actually reaches `Running`, which may be never. WebKit's own expected test output documents the never-settling case: in `Test 4: resume() while interrupted will not resume playback after an interruption`, `resume()` is called, the interruption ends without `MayResumePlaying`, the state goes to `"suspended"`, and no "promise resolved" line is ever printed ([audiocontext-state-interrupted-expected.txt](https://github.com/WebKit/WebKit/blob/main/LayoutTests/webaudio/audiocontext-state-interrupted-expected.txt)). Corroborated in the wild by [WebKit bug 281566](https://bugs.webkit.org/show_bug.cgi?id=281566), *"AudioContext.resume() never resolves if browser is suspended to background"* (iOS 17.6.1, NEW): *"`AudioContext.resume()` is never resumed or resolved/rejected."*

**This is the highest-value finding for a silent, error-free failure.** Code shaped like

```js
if (ctx.state === "suspended") await ctx.resume();
// scheduler installed below
```

does not throw, does not log, and does not continue. The `setInterval` is never created. To an observer this is indistinguishable from "the audio code did nothing".

The one divergence from spec: the spec requires `resume()` to **reject with `InvalidStateError`** when the control-thread state is `interrupted` and the state attribute is `suspended` ([spec `resume()`](https://webaudio.github.io/web-audio-api/#dom-audiocontext-resume)). WebKit's `resumeRendering()` has no such rejection path, so on iOS you get the hang instead of the rejection.

**Failure mode:** silent. **Versions:** all iOS versions with the modern API (Safari/iOS 14.5+; the same restriction machinery dates to [WebKit bug 144211](https://bugs.webkit.org/show_bug.cgi?id=144211), 2015). **Detect:** race `resume()` against a timeout; log `ctx.state` before and after.

### Does WebKit tell you anything?

Yes, but not as an error and not by default. `willBeginPlayback` emits `ALWAYS_LOG(logSiteIdentifier, "returning false, not processing user gesture or capturing")` on the `Media` log channel. `BaseAudioContext` uses `document.logger()` and `logChannel()` returns `LogMedia` ([BaseAudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/BaseAudioContext.cpp)), and `Document::didLogMessage` maps the `media` channel to `MessageSource::Media` and calls `addConsoleMessage` ([Document.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/Document.cpp)):

```cpp
static MessageSource messageSourceForWTFLogChannel(const WTFLogChannel& channel)
{
    if (equalLettersIgnoringASCIICase(channelName, "media"_s))
        return MessageSource::Media;
    ...
}
```

So attaching Safari Web Inspector to the device and looking for `Media`-source console messages (level `Log`, not `Error`) is a real diagnostic. `Document::logger()` sets `setHasEnabledInspector(hasFrontends)`, so these only appear while an inspector is attached; otherwise they go to `os_log` and are visible in Console.app.

---

## 2. Ring/Silent switch, screen lock, and `navigator.audioSession`

### Does the silent switch mute Web Audio?

**Yes, and it does not mute `<audio>`/`<video>`.** WebKit picks the AVAudioSession category by media type in [`MediaSessionManagerCocoa::updateSessionState()`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm), with Web Audio in the *last* branch:

```cpp
if (sharedSession->categoryOverride() != AudioSession::CategoryType::None)
    category = sharedSession->categoryOverride();
else if (captureCount || ...)             category = PlayAndRecord;
else if (hasAudibleVideoMediaType)        category = MediaPlayback;
else if (hasAudibleAudioOrVideoMediaType) category = MediaPlayback;
else if (webAudioCount)                   category = AudioSession::CategoryType::AmbientSound;
```

`AmbientSound` maps to `AVAudioSessionCategoryAmbient` ([AudioSessionIOS.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm)). Apple's definition of that category: *"Screen locking and the Silent switch (on iPhone, the Ring/Silent switch) silence your audio."* ([AVAudioSession.Category.ambient](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/ambient)). `playback`: *"your app audio continues with the Silent switch set to silent or when the screen locks"* ([AVAudioSession.Category.playback](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback)).

Jer Noble (Apple) states the intent explicitly in [WebKit bug 252746](https://bugs.webkit.org/show_bug.cgi?id=252746):

> "The original intent of the Web Audio API was to play short-duration, low latency sound effects. As such, we made the decision to map AudioContext generated audio to the system's 'Ambient' audio behavior. Web Audio would be allowed to mix (rather than interrupt) other currently playing audio… However, it would 'obey' the mute switch on the device… there's no way to untangle the 'mixable' with 'ignore the mute switch' from one another."

Also [bug 262781](https://bugs.webkit.org/show_bug.cgi?id=262781) (`ap@webkit.org`: *"I think that this is about Web Audio vs `<audio>`… and is actually by design"*) and [bug 237322](https://bugs.webkit.org/show_bug.cgi?id=237322) (RESOLVED CONFIGURATION CHANGED).

Note that the same `Ambient` category also means **screen lock silences the metronome**, which matters for a practice tool left running on a desk.

### The opt-out: `navigator.audioSession`

Owned by the W3C Media WG "Audio Session" spec ([ED](https://w3c.github.io/audio-session/), [TR WD 2024-11-13](https://www.w3.org/TR/audio-session/)). `AudioSessionType` values and WebKit's mapping ([DOMAudioSession.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.cpp)):

| `type` | WebKit category | AVAudioSession | Silenced by Ring/Silent switch | Mixes with other audio |
|---|---|---|---|---|
| `auto` (**default**) | `None` → media-type heuristic | `Ambient` for Web Audio | **Yes** | Yes |
| `playback` | `MediaPlayback` | `Playback` | No | **No — interrupts** |
| `transient` | `AmbientSound` | `Ambient` | Yes | Yes |
| `transient-solo` | `SoloAmbientSound` | `SoloAmbient` | Yes | No — interrupts |
| `ambient` | `AmbientSound` | `Ambient` | Yes | Yes |
| `play-and-record` | `PlayAndRecord` | `PlayAndRecord` | No | Yes |

The spec initialises `[[type]]` to `auto` ([§AudioSession](https://w3c.github.io/audio-session/#audiosession)). The spec itself never mentions the silent switch; the mapping above is only derivable by combining WebKit source with Apple's category documentation.

The last two columns are not two independent facts. `AVAudioSessionCategoryOptionMixWithOthers` is the only thing that makes a nonmixable category mix, and WebKit sets it for `PlayAndRecord` and for no other category ([AudioSessionIOS.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm)) — which is why every row that ignores the Ring/Silent switch also interrupts. Apple states the cost of `playback` outright: *"By default, using this category implies that your app's audio is nonmixable—activating your session will interrupt any other audio sessions which are also nonmixable. To allow mixing for this category, use the `mixWithOthers` option."* ([AVAudioSession.Category.playback](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback)). That option is not reachable from `navigator.audioSession`, and it is not an oversight: Jer Noble, in the same bug quoted above, says the two properties cannot be separated at all ([bug 252746 comments 2–3](https://bugs.webkit.org/show_bug.cgi?id=252746)) — *"there's no way to untangle the 'mixable' with 'ignore the mute switch' from one another."* Lifting the mute switch and interrupting the user's other audio are the same purchase.

**Shipped in Safari 16.4 / iOS 16.4** (March 2023) — [WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/) ("Support for a subset of the AudioSession Web API"), [Safari 16.4 Release Notes](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes). MDN BCD: `safari: 16.4`, `safari_ios: mirror` ([api/AudioSession.json](https://github.com/mdn/browser-compat-data/blob/main/api/AudioSession.json)).

"A subset" means **`type` only**. `state` and `onstatechange` exist in WebKit but are gated behind a non-default setting ([DOMAudioSession.idl](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.idl)):

```webidl
attribute DOMAudioSessionType type;
[EnabledBySetting=DOMAudioSessionFullEnabled] readonly attribute DOMAudioSessionState state;
[EnabledBySetting=DOMAudioSessionFullEnabled] attribute EventHandler onstatechange;
```

`DOMAudioSessionFullEnabled` is `status: testable`, default `false` ([UnifiedWebPreferences.yaml](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)). Feature-detect; do not assume.

Jean-Yves Avenard (Apple), [bug 237322 comment 6](https://bugs.webkit.org/show_bug.cgi?id=237322#c6): *"Since iOS 17, you can set the audio session type to 'playback'. Add in your code something like `navigator.audioSession.type = "playback"` and audio will not be suspended. By default the type is `ambient` and so audio will be muted if the phone is muted."*

**Version caveat:** the `setType` → `setCategoryOverride(MediaPlayback)` code shipped in 16.4, so the silent-switch override should date from 16.4, not 17.0. What genuinely landed later is *background/locked continuation* for Web Audio with `type="playback"`: [bug 261554](https://bugs.webkit.org/show_bug.cgi?id=261554), WebKit change 2024-03-01, reported shipping in iOS 17.5 in the bug's comments. Treat "16.4 for silent switch, 17.4/17.5 for background" as code-derived and Avenard's "iOS 17" as an approximation.

Two silent gotchas on `setType`, both from `DOMAudioSession.cpp`:

1. It is gated on the `microphone` Permissions Policy. Without it (e.g. a cross-origin iframe with no `allow="microphone"`), the setter **returns with no exception** and the getter keeps reporting `"auto"`.
2. `DisabledByQuirk=shouldDisableDOMAudioSession` lets WebKit remove the whole API per-site ([bug 296158](https://bugs.webkit.org/show_bug.cgi?id=296158)); `navigator.audioSession` is then `undefined`.

### Can a page detect the silent switch?

**No. There is no way.** WebKit does not even track it on iOS: `AudioSessionIOS::isMuted()` returns `false` unconditionally and `handleMutedStateChange()` has an empty body ([AudioSessionIOS.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm)); only `AudioSessionMac` implements real mute detection via `kAudioDevicePropertyMute` ([AudioSessionMac.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/mac/AudioSessionMac.mm)). The Audio Session spec defines no muted or output-volume observable. The reporter of bug 237322 asked for exactly this signal and the bug was closed without it.

The graph keeps rendering while muted: `state === "running"`, `currentTime` advances, an `AnalyserNode` still reads non-zero samples. **Mitigation, not detection:**

```js
if ("audioSession" in navigator) navigator.audioSession.type = "playback";
```

Reading the value back tells you the setter was not no-op'd by the Permissions Policy gate. It tells you nothing about the switch position.

**The mitigation is not free.** Per the table above, `playback` is nonmixable, so claiming it interrupts every other nonmixable session on the device — for a metronome, most plausibly the backing track the user is playing along to. A page that sets the type once at load and leaves it there holds that interruption for its whole life, including every second it is silent. Scope the claim to the interval that has something to claim it for, and hand it back after.

### Reverting to `auto`

**`type` is not a one-way switch.** `auto` maps to `AudioSessionCategory::None`, which is the no-override value rather than a category: the setter clears the override with `setCategoryOverride(None)` and then calls `updateAudioSessionCategoryIfNecessary()`, which re-runs the media-type heuristic in the first code block of this section and lands Web Audio back on `AmbientSound` ([DOMAudioSession.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.cpp), [MediaSessionManagerCocoa.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm)). Nothing about the override is sticky and the `AudioContext` does not have to be rebuilt to shed it.

What **could not be sourced** is the other app's side of it: whether an app the claim interrupted actually resumes once the category reverts. Reverting a category is not the same as deactivating the session, and WebKit's deactivation path, `sessionWillEndPlayback`, is gated on `presentationType() == MediaType::Audio` — an `AudioContext`'s presentation type is `WebAudio`, so that path does not apply to it at all. What iOS does for the interrupted app on a bare category change is not answerable from source and needs hardware to settle.

**Failure mode:** silent. **Versions:** all. **Detect:** impossible; mitigate on 16.4+, and give the session back when you stop.

---

## 3. `currentTime` while suspended, and events scheduled in the past

### Does `currentTime` advance while suspended?

**No, and it never catches up.** The spec defines `suspend()` as *"Suspends the progression of `AudioContext`'s `currentTime`"* and `resume()` as *"Resumes the progression of the `AudioContext`'s `currentTime` when it has been suspended"* ([spec §1.2](https://webaudio.github.io/web-audio-api/#AudioContext)). `currentTime` is *"the time in seconds of the sample frame immediately following the last sample-frame in the block of audio most recently processed"* and *"If the context's rendering graph has not yet processed a block of audio, then `currentTime` has a value of zero."*

WebKit implements it literally as a render-thread frame counter ([AudioDestinationNode.h](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioDestinationNode.h)):

```cpp
size_t currentSampleFrame() const { return m_currentSampleFrame; }
double currentTime() const { return currentSampleFrame() / static_cast<double>(sampleRate()); }
...
std::atomic<size_t> m_currentSampleFrame { 0 };
```

`m_currentSampleFrame` is only advanced by `renderQuantum()`. So on iOS: while `suspended` or `interrupted`, `currentTime` is frozen; on resume it continues from where it stopped. **`ctx.currentTime` and `performance.now()` diverge permanently by the total duration of every suspension.**

### What happens to `start(t)` when `t` is in the past?

**Not dropped — played immediately.** Spec, `AudioScheduledSourceNode.start(when)`: *"If 0 is passed in for this value or if the value is less than `currentTime`, then the sound will start playing immediately. A `RangeError` exception MUST be thrown if `when` is negative."* ([spec §1.7.2](https://webaudio.github.io/web-audio-api/#dom-audioscheduledsourcenode-start)).

**But the stop time is the trap.** Spec, `stop(when)`: *"If a stop time is reached prior to the scheduled start time, the sound will not play."* A metronome click is normally `osc.start(t); osc.stop(t + d)` with `d` a few tens of milliseconds. If the transport clock has drifted more than `d` behind `ctx.currentTime`, then **both** times are in the past, the stop precedes the start, and the note produces **no sound and no exception**. Every click in the pattern fails the same way. This is a pure silent failure and it is defined behaviour, not a bug.

`AudioParam` automation degrades the same way: `setValueAtTime`, `linearRampToValueAtTime`, `exponentialRampToValueAtTime` and `setTargetAtTime` all *"clamp to `currentTime`"* when the time argument is less than `currentTime` ([spec §1.6.3](https://webaudio.github.io/web-audio-api/#AudioParam-methods)), so a past-scheduled gain envelope collapses to an instantaneous jump rather than an audible shape.

### The concrete iOS scenario

1. Context created at page load → `suspended`, `currentTime === 0`, and it stays 0 indefinitely.
2. App reads `ctx.currentTime` for a transport origin (or seeds its own clock from `performance.now()`).
3. Either the context never runs (causes 1/2), so `currentTime` stays 0 and a lookahead loop of the form `while (next < ctx.currentTime + horizon)` schedules one window's worth and then never fires again; or
4. The context is interrupted mid-session, `currentTime` freezes while wall clock does not, and after resume every derived event time is in the past.

A lookahead scheduler that filters late events (`if (audioTime < currentTime - tolerance) continue;`) then emits **zero** events forever — the most silent possible failure. A scheduler that does not filter emits every note with `stop` before `start`, which by spec plays nothing.

**Failure mode:** silent in every variant. **Versions:** all; the freezing behaviour is spec-mandated, the divergence is amplified on iOS because interruptions are common. **Detect:** sample `ctx.currentTime` against `performance.now()` and log the drift.

---

## 4. Interruptions: calls, focus loss, backgrounding, screen lock

### `interrupted` is now in the spec

The current editor's draft has four states ([spec §1.1](https://webaudio.github.io/web-audio-api/#enumdef-audiocontextstate)):

```webidl
enum AudioContextState { "suspended", "running", "closed", "interrupted" };
```

*"This context is currently interrupted and cannot process audio until the interruption ends."* The algorithm is [§2.7 Handling an interruption on the AudioContext](https://webaudio.github.io/web-audio-api/#interruption-handling).

The published TR does **not** have it: [www.w3.org/TR/webaudio/](https://www.w3.org/TR/webaudio/) resolves to Web Audio API 1.1, FPWD 5 November 2024, with three values. Added by [PR #2611](https://github.com/WebAudio/web-audio-api/pull/2611), opened 2024-11-09, merged 2025-03-17, from [issue #2392](https://github.com/WebAudio/web-audio-api/issues/2392) (2021). WebKit shipped it a decade earlier: [bug 143190](https://bugs.webkit.org/show_bug.cgi?id=143190), *"[iOS] When Web Audio is interrupted by a phone call, it cannot be restarted"*, landed 2015-03-30 — the same change that introduced `close()`, `suspend()`, `resume()` and `onstatechange` in WebKit. Mapping that to Safari 9 / iOS 9 is inference; no Apple release note mentions the state. Developers complained it was non-standard in [bug 206695](https://bugs.webkit.org/show_bug.cgi?id=206695) (filed 2020, Safari 13/iOS 13, still NEW).

TypeScript's `AudioContextState` union still omits `"interrupted"` in most lib versions, so `state === "interrupted"` comparisons may not typecheck.

### What actually happens on iOS

Control chain: `PlatformMediaSession::beginInterruption()` → `AudioContext::suspendPlayback()` → `setState(Interrupted)`; `endInterruption(flags)` → `AudioContext::mayResumePlayback(shouldResume)`, where `shouldResume` requires `MayResumePlaying` **and** that the session was `Playing` at interrupt time ([AudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp), [PlatformMediaSession.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/PlatformMediaSession.cpp)).

| Trigger | Resulting `ctx.state` | Auto-resume |
|---|---|---|
| Phone call / Siri / another app taking exclusive audio | `"interrupted"` | Only if iOS delivers `AVAudioSessionInterruptionOptionShouldResume`; otherwise → `"suspended"` and the page must call `resume()` |
| Another app on a *mixable* session (e.g. Clock timer) | stays `"running"`, silent | n/a — no interruption is delivered |
| App backgrounded / app switch | `"interrupted"` | On foreground, only if the session was `Playing` |
| Screen lock | `"interrupted"` (Web Audio has no `SuspendedUnderLockPlaybackRestricted`, so it takes the plain background path — [MediaSessionManagerIOS.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/MediaSessionManagerIOS.mm)) | as above |
| Switching Safari tabs | ⚠️ **unsourced** — see below | unestablished — the state itself is unsourced |

Background interruption can be waived: `AudioContext::shouldOverrideBackgroundPlaybackRestriction()` returns true for `EnteringBackground` when `navigator.audioSession.type` is `playback` or `play-and-record` ([AudioContext.cpp `hasPlayBackAudioSession`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp), [bug 261554](https://bugs.webkit.org/show_bug.cgi?id=261554)).

### Does `statechange` fire?

WebKit fires it on **every** transition, with no privacy suppression ([BaseAudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/BaseAudioContext.cpp)):

```cpp
if (m_state != state) {
    m_state = state;
    queueTaskToDispatchEvent(*this, TaskSource::MediaElement, Event::create(eventNames().statechangeEvent, ...));
}
```

The spec, by contrast, deliberately suppresses the event when interrupting an already-suspended context: *"If the AudioContext is suspended a statechange event is not fired for privacy reasons to avoid over-sharing user activity - e.g. when a phone call comes in or when the screen gets locked."* ([spec §2.7](https://webaudio.github.io/web-audio-api/#interruption-handling)). WebKit currently diverges here.

**Every transition, but a refused `resume()` is not a transition.** `AudioContext::resumeRendering` parks the promise and returns on the `if (!willBegin)` branch — the not-allowed-to-start case quoted in §1 — without ever calling `setState`, and its failure path returns the same way ([AudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)). Even a call that does reach `setState` is silent unless something actually changed, because the dispatch above is inside `if (m_state != state)` ([BaseAudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/BaseAudioContext.cpp)). So a refused or failed resume produces **no event, no rejection, and no state change** — nothing observable whatsoever.

That settles a design question that otherwise looks dangerous: a `statechange` handler that responds by calling `resume()` cannot drive itself in a loop. A refusal is silent, so the handler cannot re-enter through it, and no attempt cap, backoff or rate limit is needed to stop it. Only a genuine transition can run it again.

There is a second divergence from the spec in the same area, and it is the reason the loop question has a different answer on a conforming engine. The editor's draft gives `resume()` a branch that both fires the event and rejects: when `state` is `"suspended"` and `[[control thread state]]` is `"interrupted"`, it fires `statechange` *and* rejects the promise with `InvalidStateError` ([spec `resume()`](https://webaudio.github.io/web-audio-api/#dom-audiocontext-resume)). WebKit implements neither half — no rejection (§1) and no event — so a page written against the spec is told twice about a refused resume, and on iOS is told nothing.

### `resume()` while interrupted

WebKit's own layout test is the behaviour contract ([audiocontext-state-interrupted-expected.txt](https://github.com/WebKit/WebKit/blob/main/LayoutTests/webaudio/audiocontext-state-interrupted-expected.txt)):

- Test 2 — without `InterruptedPlaybackNotPermitted` (the iOS Web Audio default): `resume()` *ends* the interruption; promise resolves, state `running`.
- Test 1 — with the restriction: the promise stays pending until the interruption ends with `MayResumePlaying`.
- Test 3 — interruption ends without `MayResumePlaying`: `statechange`, state `"suspended"`, no error.
- Test 4 — `resume()` during interruption, interruption ends without `MayResumePlaying`: state `"suspended"` and **the promise is never settled**.

### "Running but silent" — an open WebKit bug family

This is the one that most cleanly matches "no sound, no errors, `state` looks fine":

| Bug | Title | Versions | Status |
|---|---|---|---|
| [283419](https://bugs.webkit.org/show_bug.cgi?id=283419) | iOS AudioContext does not change state from running when an external system app starts to play sounds | iOS 18 | NEW |
| [263627](https://bugs.webkit.org/show_bug.cgi?id=263627) | [iOS] AudioContext is not consistently resumed when page is brought to foreground — *"state 'running', but currentTime is not increasing"* | iOS 17.0.3 | NEW |
| [291892](https://bugs.webkit.org/show_bug.cgi?id=291892) | WebAudio AudioContext silent after PWA returns from background, even after resuming it | iOS 18 → iOS 26 betas | NEW |
| [202846](https://bugs.webkit.org/show_bug.cgi?id=202846) | AudioContext stops playing when suspended on visibilitychange | iOS 13.1.2 | NEW |
| [276016](https://bugs.webkit.org/show_bug.cgi?id=276016) | REGRESSION (iOS 17.4.1–17.5.1): Web Audio sounds stop playing after losing focus | iOS 17.4.1+ | NEW |
| [273511](https://bugs.webkit.org/show_bug.cgi?id=273511) | AudioContext stuck on Interrupted — *".resume() does not work"* | iOS 17 | NEW |
| [281955](https://bugs.webkit.org/show_bug.cgi?id=281955) | [iOS] AudioContext is not resuming when page is put to foreground — filed by a WebKit engineer; log line *"failed to activate audio session, error: Session activation failed"* | Safari 18 | NEW |
| [237878](https://bugs.webkit.org/show_bug.cgi?id=237878) | AudioContext is suspended on iOS when page is backgrounded | — | RESOLVED FIXED (2022-03-17) |

The recurring reporter workaround is `await ctx.suspend(); await ctx.resume();`, in [bug 283419 comment 3](https://bugs.webkit.org/show_bug.cgi?id=283419) and [bug 263627 comment 3](https://bugs.webkit.org/show_bug.cgi?id=263627). Both describe the `running`-but-frozen case specifically — which is exactly the case that fires no `statechange` at all, the state having never changed, so the cycle has to be driven by something else: a `visibilitychange` handler, or a clock-drift probe of the kind below.

[Bug 202846](https://bugs.webkit.org/show_bug.cgi?id=202846) is often cited alongside those two but carries no such comment. Its only workaround is a delay: *"put the ctx.resume() call … in a setTimeout with about 300ms"* (Jesper van den Ende, 2019-10-11).

**Failure mode:** silent throughout. `statechange` is the only signal for state transitions; for the running-but-dead case there is no signal at all except a frozen `currentTime`.

---

## 5. `webkitAudioContext` prefixing

| | `webkitAudioContext` | `AudioContext` |
|---|---|---|
| Safari (macOS) | 6 → **removed in 14.1** | **14.1** |
| Safari iOS | 6 → **removed in 14.5** | **14.5** |

MDN BCD ([api/AudioContext.json](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json)) records the prefixed entry with `version_removed: "14.1"` and the unprefixed with `version_added: "14.1"`. **There is no shipping Safari where both names exist** — the switchover is atomic.

WebKit trail: [bug 213268](https://bugs.webkit.org/show_bug.cgi?id=213268) "Add experimental feature flag for modern & unprefixed WebAudio API" (2020-06-18); [bug 216886](https://bugs.webkit.org/show_bug.cgi?id=216886) "Turn off the legacy prefixed WebAudio API" (2020-09-23); [bug 225832](https://bugs.webkit.org/show_bug.cgi?id=225832) "Drop legacy / prefixed WebAudio implementation" (2021-05-15). Shipping announcement: [New WebKit Features in Safari 14.1](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/) — *"Updates to the Web Audio API bring it to standards compliance. It is now available unprefixed with support for advanced audio processing via Audio Worklets."*

Current WebKit asserts the prefixed name is gone, via the imported WPT ([historical-expected.txt](https://github.com/WebKit/WebKit/blob/main/LayoutTests/imported/w3c/web-platform-tests/webaudio/historical-expected.txt)):

```text
PASS webkitAudioContext interface should not exist
```

On Safari ≤ 14.0 / iOS ≤ 14.4, `new AudioContext()` throws `ReferenceError: Can't find variable: AudioContext` — **loud**, never silent. The legacy prefixed interface was also a *different* interface, not an alias: its `decodeAudioData` returned `undefined` with a required success callback, so `ctx.decodeAudioData(buf).then(...)` throws there too.

`window.AudioContext || window.webkitAudioContext` is therefore harmless but dead: the right-hand branch is unreachable on any iOS that can run it, and on older iOS it yields an incompatible object. **This cannot cause a silent failure and is ruled out by "no errors".**

Legacy method names (`noteOn`/`noteOff`, `createGainNode`, `createDelayNode`) were removed in [bug 161262](https://bugs.webkit.org/show_bug.cgi?id=161262) (2016) — also loud failures.

---

## 6. Node support and other per-node constraints

### `StereoPannerNode`

Shipped Safari 14.1 / iOS 14.5, implemented by [bug 215518](https://bugs.webkit.org/show_bug.cgi?id=215518) (2020-08-20) on the modern `BaseAudioContext`; BCD `safari: 14.1`, `safari_ios: 14.5` ([api/StereoPannerNode.json](https://github.com/mdn/browser-compat-data/blob/main/api/StereoPannerNode.json)). Both pre-14.5 failure modes are **loud**: `ctx.createStereoPanner()` → `TypeError: ... is not a function`; `new StereoPannerNode(ctx)` → `ReferenceError`. An unsupported node never silently outputs nothing.

### Number of contexts / nodes

WebKit's `maxHardwareContexts = 4` limit is `#if OS(WINDOWS)` only ([AudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)); **iOS and macOS have no cap**, and when the Windows cap trips it throws `QuotaExceededError` — loud. (The spec permits an implementation-defined maximum with `NotSupportedError`; Chrome's 6-per-tab limit is a Blink behaviour, not WebKit.) No limit exists anywhere in WebKit on `OscillatorNode`/`GainNode` counts; overload manifests as render-thread glitching, not clean silence. **No primary source documents a "too many nodes ⇒ silence" behaviour** — treat that claim as unsupported.

### Sample rate and route changes — a real, partly-silent iOS bug

iOS does not hardcode 44100 or 48000; WebKit reads `[[AVAudioSession sharedInstance] sampleRate]` live ([AudioSessionIOS.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm)). A `sampleRate` constructor option is honoured and resampled, with `NotSupportedError` (loud) outside 3000–384000 Hz ([BaseAudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/BaseAudioContext.cpp)).

There is **no iOS code path that recreates the destination when the hardware rate changes** (`sampleRateDidChange` exists only for macOS and the remote session; `recreateDestination()` is called only from `enableInput()` and `setChannelCount()`). Consequence, per [bug 258864](https://bugs.webkit.org/show_bug.cgi?id=258864) (NEW, iOS 16, filed 2023): switching to a Bluetooth speaker mid-session gives audio that *"will play but is very likely to be badly distorted and play at the wrong speed"*. `<audio>` is unaffected; Chrome/Firefox are unaffected. See also [bug 99231](https://bugs.webkit.org/show_bug.cgi?id=99231) (open since 2012). This is semi-silent — wrong pitch and tempo, no exception — and matters for a metronome specifically, because "wrong speed" is a correctness bug even when audible. Detect by comparing `ctx.sampleRate` against a baseline; the only fix is `close()` and rebuild.

---

## 7. The "unlock" idiom (silent buffer inside the first gesture)

**Historically real, obsolete since 2015, and never a special case today.**

The primary source is the WebKit commit message for [bug 144211](https://bugs.webkit.org/show_bug.cgi?id=144211), *"[WebAudio] AudioContext does not remove user-gesture restriction during resume()"* (2015-04-27):

> "Before the introduction of resume(), suspend(), and stop(), AudioContexts which required a user-gesture would start normally, but would effectively mute their outputs. Now that the AudioContext's state property is exposed to JavaScript, the AudioContext should stay in the 'suspended' state until the user-gesture restriction is lifted.
>
> Add a new method, willBeginPlayback() which checks and potentially clears the context's behavior restrictions before checking with the MediaSession."

That is the origin of the idiom: pre-2015 WebKit, the *only* way to clear the restriction was to start a source node inside the gesture, because `resume()` did not clear it. Since that change, `resume()` inside the gesture is sufficient.

Starting a source node still works as an unlock path, but it is now the same code path, with no privilege ([AudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)):

```cpp
void AudioContext::sourceNodeWillBeginPlayback(AudioNode& audioNode)
{
    ...
    if (userGestureRequiredForAudioStart())
        startRendering();
}
```

`startRendering()` → `willBeginPlayback()` → the same `hasTransientActivation()` check. The spec codifies the same equivalence in `start(when)`: *"Send a control message to the associated AudioContext to start running its rendering thread only when all the following conditions are met: The context's `[[control thread state]]` is 'suspended'. The context is allowed to start. `[[suspended by user]]` flag is false."* with the note *"This can allow start() to start an AudioContext that is currently allowed to start, but has previously been prevented from starting."* ([spec §1.7.2](https://webaudio.github.io/web-audio-api/#dom-audioscheduledsourcenode-start)).

**Verdict:** playing a zero-length or silent buffer inside the first gesture is *not* required on any current iOS. It is harmless, and it has one genuine remaining advantage: it is synchronous and returns no promise, so it cannot deadlock the way `await ctx.resume()` can. It cannot help with the silent switch — a *silent MP3 in an `<audio>` element* can, because an audible media element pulls the process into the `MediaPlayback` category (see §2), but that is a different trick with a different mechanism, and `navigator.audioSession.type = "playback"` is the supported replacement on 16.4+.

---

## Runtime diagnostics

Add this before touching anything else. It distinguishes every cause above that is distinguishable.

```js
// 1. Log the constructor result and every transition.
const ctx = new AudioContext({ latencyHint: "interactive" });
console.log("[audio] created", {
  state: ctx.state,                       // "suspended" everywhere — not diagnostic on its own
  sampleRate: ctx.sampleRate,
  audioSession: "audioSession" in navigator ? navigator.audioSession.type : "unsupported",
});
ctx.addEventListener("statechange", () => {
  console.log("[audio] statechange", ctx.state, ctx.currentTime.toFixed(3), performance.now().toFixed(0));
});

// 2. Never await a bare resume(). Race it.
async function resumeOrReport(ctx) {
  const before = ctx.state;
  let settled = false;
  const p = ctx.resume().then(
    () => { settled = true; return "resolved"; },
    (e) => { settled = true; return "rejected:" + e.name; },
  );
  const outcome = await Promise.race([p, new Promise(r => setTimeout(() => r("PENDING"), 1000))]);
  console.log("[audio] resume", { before, after: ctx.state, outcome, settled });
  return outcome;
}

// 3. Clock-drift probe: is the render thread actually alive?
let lastCtx = ctx.currentTime, lastPerf = performance.now();
setInterval(() => {
  const c = ctx.currentTime, p = performance.now();
  const dCtx = c - lastCtx, dPerf = (p - lastPerf) / 1000;
  console.log("[audio] tick", {
    state: ctx.state,
    currentTime: c.toFixed(3),
    ctxAdvance: dCtx.toFixed(3),
    wallAdvance: dPerf.toFixed(3),
    frozen: ctx.state === "running" && dCtx < dPerf / 2,
    outputTs: ctx.getOutputTimestamp?.(),   // Safari 14.1+
  });
  lastCtx = c; lastPerf = p;
}, 500);

// 4. Prove the gesture is real, in the handler itself.
button.addEventListener("pointerup", (e) => {
  console.log("[audio] gesture", { type: e.type, isTrusted: e.isTrusted, pointerType: e.pointerType });
  resumeOrReport(ctx);
});
```

### Decision table

| Observation | Cause | Section |
|---|---|---|
| `resume` logs `outcome: "PENDING"` | Not allowed to start, or interrupted. WebKit parks the promise; any `await` on it deadlocks | §1, §4 |
| `state` stays `"suspended"`, `currentTime` stays `0.000` | Never got user activation | §1 |
| Gesture log shows `type: "touchstart"` or `pointerdown` with `pointerType: "touch"` | Not an activation-triggering event | §1 |
| `resume` resolves; `state: "running"`; `currentTime` advances; still no sound | Ring/Silent switch, screen lock, or Control Center volume. Undetectable — set `navigator.audioSession.type = "playback"` and retest | §2 |
| `state: "interrupted"` in the `statechange` log | Call, other app, background, or lock. Check whether the next transition is `running` (auto-resumed) or `suspended` (you must resume) | §4 |
| `state: "running"` but `frozen: true` | Known open WebKit bug family (283419 / 263627 / 291892), and the one case that fires no `statechange`. Workaround, reported in 283419 and 263627 only: `await ctx.suspend(); await ctx.resume();` | §4 |
| `ctxAdvance` tracks `wallAdvance` but your transport origin predates the first `running` transition | Events computed in the past; `stop` before `start` plays nothing | §3 |
| `sampleRate` differs from the value logged at construction | Route change (Bluetooth/headphones); rebuild the context | §6 |
| `audioSession: "unsupported"` | iOS < 16.4, or the API was removed by Permissions Policy / site quirk | §2 |
| Any `ReferenceError` / `TypeError` | Prefixing or unsupported node — loud, and therefore *not* this bug | §5, §6 |

Also worth doing once: attach Safari Web Inspector from a Mac and look for `Media`-source console messages. WebKit emits `"returning false, not processing user gesture or capturing"` on that channel when it refuses to start Web Audio, and it is routed to the page console when an inspector is attached ([Document.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/Document.cpp), [BaseAudioContext.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/BaseAudioContext.cpp)). It is logged at `Log` level, not `Error`, so a console filtered to errors will not show it.

---

## Version reference

| Capability | Safari (macOS) | Safari iOS | Source |
|---|---|---|---|
| `webkitAudioContext` | 6 – 14.0 | 6 – 14.4 | [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json) |
| Unprefixed `AudioContext` | 14.1 | 14.5 | [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json), [Safari 14.1 features](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/) |
| `suspend()` / `resume()` / `close()` / `onstatechange` | 9 | 9 | [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json), [WebKit bug 143190](https://bugs.webkit.org/show_bug.cgi?id=143190) |
| `"interrupted"` state (WebKit) | 2015 change, Safari 9 era (inferred) | same | [WebKit bug 143190](https://bugs.webkit.org/show_bug.cgi?id=143190) |
| `"interrupted"` state (spec ED) | merged 2025-03-17 | — | [PR #2611](https://github.com/WebAudio/web-audio-api/pull/2611) |
| `StereoPannerNode` | 14.1 | 14.5 | [WebKit bug 215518](https://bugs.webkit.org/show_bug.cgi?id=215518) |
| `getOutputTimestamp()` / `baseLatency` | 14.1 | 14.5 | [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json) |
| `outputLatency` | 18.4 | 18.4 | [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json) |
| `navigator.audioSession.type` | 16.4 | 16.4 | [Safari 16.4 features](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/), [release notes](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes) |
| `audioSession.type = "playback"` waives background interruption | — | 17.4 / 17.5 (see §2 caveat) | [WebKit bug 261554](https://bugs.webkit.org/show_bug.cgi?id=261554) |
| `audioSession.state` / `onstatechange` | **not shipped** (`DOMAudioSessionFullEnabled`, default false) | same | [DOMAudioSession.idl](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.idl) |
| `AudioContext` `error` event | not supported | not supported | [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json) |

Note the last row: the spec's resource-acquisition failure path *"queue a media element task to fire an event named `error` at the AudioContext"* ([spec §1.2.1](https://webaudio.github.io/web-audio-api/#AudioContext-constructors), [§2.8](https://webaudio.github.io/web-audio-api/#error-handling-on-a-running-audio-context)) is **not implemented in Safari**. Audio-hardware acquisition failure on iOS is therefore silent by omission, not just by design.

## Claims with no primary source

Recorded so they are not repeated as fact:

- **"Web Audio uses the ringer volume slider, media elements use the media volume slider."** Widely repeated, including by the reporter of [bug 237322](https://bugs.webkit.org/show_bug.cgi?id=237322). No Apple or WebKit source states it. The authoritative WebKit reply frames the difference purely as `Ambient` vs `Playback` category semantics (mixable + obeys the mute switch, versus interrupting + ignores it), never as two volume sliders. Treat the volume-slider framing as unverified.
- **Control Center volume behaving differently for Web Audio than for media elements.** No primary source either way.
- **Switching between Safari tabs putting an `AudioContext` into `interrupted`.** Asserted by [MDN](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state) and by bug reporters ([202846](https://bugs.webkit.org/show_bug.cgi?id=202846)), but no corresponding WebKit code path was found: `InterruptionType::PageNotVisible` is declared with no call sites, and `BackgroundTabPlaybackRestricted` is enforced only for media elements. Likely mediated by generic page suspension rather than a tab-visibility rule.
- **A WebKit blog post or WWDC session explaining the Web Audio gesture requirement or `navigator.audioSession` in depth.** Does not exist. [New `<video>` Policies for iOS](https://webkit.org/blog/6784/new-video-policies-for-ios/) and [Auto-Play Policy Changes for macOS](https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/) cover media elements only and never mention Web Audio. The only first-party prose about `audioSession` is a one-line release-note entry; everything else is source code and Bugzilla.
- **The exact iOS version at which `type="playback"` began defeating the silent switch.** Code says 16.4; the one first-party statement says "iOS 17". Unresolved.
- **Whether an app interrupted by a `playback` claim resumes when the page reverts to `auto`.** The revert itself is sourced (§2): `auto` is `AudioSessionCategory::None`, which clears the override and re-runs the heuristic. What is not sourced is the other app's side of it. Reverting a category is not deactivating the session, and WebKit's `sessionWillEndPlayback` deactivation path is gated on `presentationType() == MediaType::Audio`, which an `AudioContext` (`WebAudio`) never satisfies. Needs hardware.
- **A documented "too many concurrent nodes ⇒ silence" behaviour in WebKit.** None found; the only numeric guards are channel counts and periodic-wave size, which throw.
- **Whether iOS 26.2 fixes [bug 291892](https://bugs.webkit.org/show_bug.cgi?id=291892).** A reporter comment only; no Apple or WebKit confirmation.
