# Milestones 0–2 validation record

Status: **NOT ACCEPTED — outstanding Windows/manual rows remain untested.**

This record closes only the early Windows prerequisites required before formal Milestone 5 acceptance. Milestone 3 is accepted in `milestone-3.md`; Milestone 4 is accepted in `milestone-4.md`. Those reports are evidence for their own gates and do not prove overlay, fullscreen, shortcut, or capture-path compatibility.

## Immutable environment record

- Campaign ID:
- Date/time and tester:
- Git commit and PresenterAI version:
- Windows edition/build:
- Electron version:
- Chrome and Google Meet versions:
- PowerPoint version:
- OBS version and selected capture backend:
- GPU and driver:
- Monitors, connection types, resolutions, scaling, and primary display:
- Audio endpoints and drivers:

Do not edit completed evidence in place. Correct a mistake by appending a dated correction that identifies the affected case ID.

### Automated run — 2026-07-14

- Worktree: local `main` changes, not committed or published.
- Windows: Windows 11 Home Single Language, build 26200.
- Electron: 43.1.0; Chrome: 150.0.7871.101; PowerPoint: 16.0.20131.20126.
- GPUs: Intel Graphics 32.0.101.7084 and NVIDIA RTX 4050 Laptop GPU 32.0.16.1062.
- OBS: not installed, so its manual capture rows are blocked until it is available.
- Installer SHA-256: `3AF464BAF6F5843517C9A4861C3A2F6D7DBC08C257D3D371DEF1F2A35ACF5F0D`.
- Fresh Electron extraction was repeatedly locked by local Windows Application Control/real-time scanning. The final local package therefore copied the already trusted, pinned Electron 43.1.0 distribution. The resulting unpacked `PresenterAI.exe` launched directly and passed both the FTS5 and bundled-helper probes. Clean NSIS install, upgrade, uninstall, and installed interactive launch remain manual rows.
- Current beta.2 non-billable regression evidence: 353 Vitest tests in 50 files, 33/33 .NET tests in the latest isolated run, 9/9 Playwright Electron tests, zero dependency vulnerabilities, and 50/50 M4 retrieval cases. Code Integrity has blocked unsigned local payloads; the strict wrapper fails instead of accepting zero tests, and clean Windows CI must execute at least 29 helper tests.
- The complete regression, audit, M4, and zero-network M6 preflight set was reverified on 2026-07-16; package/helper-smoke measurements below remain the immutable 2026-07-14 records.
- The latest helper smoke produced a 12,910 ms, 413,166-byte, 16 kHz mono WAV on the Realtek default endpoint and deleted it. A preceding stale Bluetooth-endpoint attempt was invalidated by Windows; enumeration exposed the new default and a retry passed. This is diagnostic only, not M0 Meet intelligibility or M5 device-switch acceptance.

## M0 architecture-spike closeout

| Case ID | Gate | Result | Evidence / notes |
|---|---|---|---|
| M0-PKG-01 | Windows 11 x64 packaged app launches | Pass (automated unpacked probe) | Final `PresenterAI.exe` launched and passed FTS5 plus bundled-helper health probes; NSIS install/upgrade/uninstall remain manual |
| M0-WIN-01 | Transparent, movable, resizable, always-on-top overlay | Pass (automated) | Playwright verifies hardened overlay properties; fullscreen behavior remains in M1-FS rows |
| M0-WIN-02 | Click-through can always be escaped | Pass (automated) | Playwright verifies emergency shortcut recovery |
| M0-WIN-03 | HWND and Electron protection diagnostics remain internally consistent | Partial | Electron reports protection enabled; HWND/manual capture-path diagnostics remain unverified; does not prove exclusion |
| M0-AUD-01 | System loopback captures intelligible Meet speech in 19/20 clips | Untested | Reuse accepted M5 case IDs when available |
| M0-KEY-01 | Toggle shortcut produces one start/stop pair in 50 trials | Untested | Reuse accepted M5 case IDs when available; this is the documented user-directed replacement for hold/release |
| M0-FTS-01 | Packaged FTS5 returns known fixture chunks | Pass (M4) | Cross-reference `milestone-4.md`; do not rerun manually |
| M0-AI-01 | Typed model/schema and unsupported-claim gates | Pass (M3) | Cross-reference `milestone-3.md`; no API rerun |

Process-tree Chrome capture is **not promoted**. PresenterAI supports system WASAPI loopback only.

## M1 overlay-shell closeout

| Case ID | Gate | Result | Evidence / notes |
|---|---|---|---|
| M1-AUTO-01 | Production security configuration has no Electron warning | Pass | Playwright production bundle: strict CSP, sandbox, context isolation, no Node integration; complete beta.2 suite 9/9 passes |
| M1-AUTO-02 | Hide/show, click-through escape, tray Show/Settings/Quit | Partial | Playwright exercises close-to-tray, hide/show, emergency recovery, and the actual tray Show/Settings callbacks; tray Quit and installed-app availability remain manual |
| M1-DSP-01 | Saved bounds clamp to each currently connected monitor | Partial | Invalid saved bounds are fully contained on the current display, including DWM shadow; monitor removal/scaling change remains manual |
| M1-FS-01 | Overlay remains above Chrome presentation/fullscreen | Untested | |
| M1-FS-02 | Overlay remains above PowerPoint Slide Show | Untested | |
| M1-SC-01 | Shortcut conflict is visible and does not replace recovery shortcuts | Pass (automated) | Playwright reserves the accelerator externally, then verifies visible rejection, rollback, and retained emergency registrations |
| M1-TASK-01 | No taskbar button; tray remains available | Untested | |

## M2 capture-protection closeout

Run every row with protection OFF first, then protection ON. Copy the immutable outcome into `docs/capture-compatibility/matrix.md` and the in-app compatibility recorder.

| Case ID | Capture path | OFF control | ON result | Evidence ID |
|---|---|---|---|---|
| M2-CAP-01 | Google Meet — entire screen | Untested | Untested | |
| M2-CAP-02 | Google Meet — Chrome window | Untested | Untested | |
| M2-CAP-03 | Google Meet — Chrome tab | Untested | Untested | |
| M2-CAP-04 | Windows Snipping Tool | Untested | Untested | |
| M2-CAP-05 | OBS Display Capture | Untested | Untested | |
| M2-CAP-06 | OBS Window Capture — Chrome | Untested | Untested | |
| M2-CAP-07 | OBS Window Capture — PresenterAI | Untested | Untested | |

Allowed results are `overlay-absent`, `overlay-black`, `overlay-visible`, `unsupported`, and `untested`. A Chrome tab/window source omitting the desktop overlay is an observation, not proof of Windows display-affinity support.

## Decision

- M0 accepted by/date:
- M1 accepted by/date:
- M2 accepted by/date:
- Blocking case IDs:
- Corrections or exceptions: none permitted without a dated rationale and rerun.
