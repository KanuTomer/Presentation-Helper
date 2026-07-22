# Milestone 5 toggle-listening validation record

Status: **NOT ACCEPTED — automated gate passed; M0–M2 and physical-device validation remain pending.**

M5 may be accepted only after M0–M2 are signed off in `milestones-0-2.md`. This record validates bounded system WASAPI loopback and a restricted toggle shortcut; it does not validate process-specific capture, microphone fallback, or continuous listening. Toggle behavior intentionally replaces the original hold/release interaction at the user's direction: one press starts capture and the next press stops capture and requests transcription. The transcript must be reviewed and submitted separately before an answer is requested.

## Build and environment

- Campaign ID:
- Git commit / installer SHA-256:
- Date/time and tester:
- Windows edition/build:
- Helper protocol/features:
- Chrome/Meet version:
- Output endpoints and drivers:
- Available endpoint classes: speakers / wired / Bluetooth / USB
- Unavailable endpoint classes and reason:

Latest beta.2 local regression run: 2026-07-22 on Windows 11 build 26200, Electron 43.1.0. It passed 351 Vitest tests in 50 files, 9/9 Playwright Electron tests, an audit with zero vulnerabilities, and the accepted 50/50 M4 retrieval corpus. A two-cycle helper smoke produced valid 16 kHz mono captures through the selected render endpoint, and packaged FTS/helper probes passed after reputation evaluation. Smart App Control still blocks the unsigned .NET test assembly, so the strict local test gate is recorded as blocked and clean Windows CI remains authoritative. Physical Meet acceptance remains separate evidence.

The latest helper smoke enumerated the available render endpoints and produced a 12,910 ms, 413,166-byte, 16 kHz mono PCM recording from the current Realtek default endpoint, then removed the WAV. An initial attempt against a previously selected Bluetooth endpoint failed when Windows invalidated that endpoint; subsequent visible enumeration identified the Realtek default and allowed a successful retry. This is useful device-change diagnostic evidence only. It does **not** pass the required in-app endpoint-removal/default-switch recovery row or prove Meet intelligibility.

## Automated evidence

| Case ID | Gate | Result | Evidence / notes |
|---|---|---|---|
| M5-AUTO-01 | Audit, typecheck, Vitest, helper tests, Playwright, M4 regression, production build | Pending clean CI | Local audit: 0 vulnerabilities; Vitest: 50 files / 351 tests; Playwright: 9/9; M4: 50/50; typecheck and production build pass. Local .NET assembly load is blocked by Smart App Control; zero discovered tests is now a hard failure. |
| M5-AUTO-02 | Packaged helper v2 handshake and required features | Pass | The final unpacked PresenterAI executable launched and reported protocol v2 plus all 9 required features from its bundled helper |
| M5-AUTO-03 | A second toggle during startup is latched exactly once | Pass | Deterministic controller race tests |
| M5-AUTO-04 | Cancel during startup/finalization reaches one terminal cleanup | Pass | Coordinator/controller cleanup and cancellation-boundary tests |
| M5-AUTO-05 | Stale/duplicate events cannot change a newer operation | Pass | Operation-ID and duplicate-terminal tests |
| M5-AUTO-06 | Idle crash restarts once; active/second crash fails safely | Pass | Helper crash/restart controller tests |
| M5-AUTO-07 | Missing endpoint falls back once to the current default with warning | Pass (automated) | Endpoint-loss and single-fallback tests; the Bluetooth-to-Realtek smoke transition is diagnostic only and does not replace the in-app manual row |
| M5-AUTO-08 | WAV is 16 kHz mono PCM, 250 ms–90 s, with one final file | Pass | Native conversion/limit tests, byte-level validator tests, and real helper smoke |
| M5-AUTO-09 | Cancel, failure, exit, and stale-startup cleanup remove owned files | Pass | Cleanup-path tests; real smoke WAV confirmed absent after terminal cleanup |

## Fifty-cycle shortcut campaign

Record one row per physical cycle. `Start events` and `terminal events` must both equal one. `Indicator ms` is measured from confirmed helper capture start to the renderer's first-frame acknowledgement.

| Trial | Endpoint | Scenario | Start events | Terminal events | Indicator ms | WAV valid | Temp removed | Result / notes |
|---:|---|---|---:|---:|---:|---|---|---|
| 01–50 | | normal toggle / rapid second toggle / autorepeat / Esc / recovery | | | | | | Untested |

Required aggregate:

- 50/50 trials have exactly one start and one terminal event.
- Listening indicator is confirmed within 150 ms in all timed normal-start trials.
- Esc and every failure/cancel path remove temporary audio.
- Listening is OFF after every launch and restart.

## Meet and endpoint matrix

Use 20 designated shortcut trials with real reviewer speech in Google Meet. Test each available endpoint class; unavailable hardware is recorded as unavailable, never passed.

| Endpoint / trial IDs | Trials | Intelligible | Device removal/default switch | Recoverable UI | Result / notes |
|---|---:|---:|---|---|---|
| Speakers | | | | | Untested |
| Wired headphones | | | | | Untested |
| Bluetooth | | | | | Untested |
| USB | | | | | Untested |

Acceptance requires intelligible reviewer speech in at least 19/20 designated Meet trials and a visible recoverable outcome for endpoint removal/default switching.

## Decision

- Aggregate starts/stops:
- Meet intelligibility:
- Maximum confirmed indicator latency:
- Temporary-file failures:
- Blocking case IDs:
- Human sign-off / date:
- Decision: **Untested**
