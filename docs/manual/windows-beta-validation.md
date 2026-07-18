# Windows beta validation

Do not infer any result from the protection request or Electron's reported state. Record exact versions and test protection OFF before protection ON.

This is the operator runbook. Record immutable results in:

- `docs/validation/milestones-0-2.md` for early Windows and capture prerequisites;
- `docs/validation/milestone-5.md` for push-to-listen;
- `docs/validation/milestone-6.md` for transcription-to-response;
- `docs/capture-compatibility/matrix.md` for capture-path observations.

Milestones 3 and 4 are already accepted in their respective reports. Do not spend API credits rerunning M3 or repeat the offline M4 corpus as manual evidence.

Milestones 5 and 6 are **not accepted**. The current non-billable gate passes 196 Vitest tests in 28 files, 29/29 .NET tests, 5/5 Playwright Electron tests, an audit with zero high-severity findings, and the 50/50 M4 corpus. Those results do not replace the fullscreen, capture-path, Meet, physical-device, or installed-app rows below.

> **M6 paid campaign safety stop:** the current zero-network preflight estimates $0.148247, but its documented worst-case bound is $0.644547. Because that exceeds the immutable $0.15 cap, it reports `strictCampaignFeasible=false`, sets `billableExecutionEnabled=false`, and refuses live execution. M6 has spent $0. Do not supply the API key or run billable cases until the user separately revises the case count or cap.

## Environment

- Date and tester:
- Windows edition/build:
- PresenterAI/Electron version:
- Chrome and Google Meet version:
- OBS version and capture backend:
- GPU and driver:
- Monitor layout/scaling:
- Output devices tested:

## Audio matrix

Run the matrix once for speakers, wired headphones, and each available Bluetooth or USB output. Select the endpoint in Settings before each run.

| Check | Result | Evidence / notes |
|---|---|---|
| 20 hold/release trials; no duplicate starts or stops | Untested | |
| Intelligible Meet speech in at least 19/20 trials | Untested | |
| Confirmed-capture indicator appears within 150 ms | Untested | |
| Esc cancels capture and deletes temporary audio | Untested | |
| Removing the selected device gives a visible recoverable error | Untested | |
| Changing the default device falls back visibly | Untested | |
| Ten transcription-to-answer trials completed | Untested | |
| Release-to-answer p50 / p95 | Untested | Record stage timings |
| Temporary WAV deleted after every terminal outcome | Untested | |

The local command `npm run test:helper-smoke` is an automated format and lifecycle check. It is not a substitute for intelligibility testing with a live Meet session.

The latest smoke succeeded on the Realtek default endpoint (12.94 seconds, 414,126 bytes, 16 kHz mono, WAV removed). A first attempt against a stale Bluetooth endpoint was invalidated by Windows; enumeration then exposed Realtek as the default and allowed retry. Record this as a diagnostic only—do not mark device-removal, default-switch, or Meet rows passed from it.

The final campaign is stricter than the compact table above: perform 50 physical shortcut cycles, designate 20 for real Meet intelligibility/transcription review, and designate ten of those for the complete response pipeline. Enter individual case IDs and measurements in the M5/M6 records. Do not store audio, transcripts, prompts, or answers as evidence.

## Required execution order

1. Run the complete non-billable automated gate and packaged helper smoke.
2. Complete multi-monitor, fullscreen, shortcut-conflict, and capture OFF/ON rows for M0–M2.
3. Complete all 50 M5 shortcut cycles and the physical endpoint matrix.
4. Sign off M5 only if its strict thresholds pass.
5. Stop before the paid M6 phase. Obtain a separate user decision that changes the case count or budget cap enough for the strict documented bound; the existing $0.15 authorization cannot start the current 20-case campaign.
6. After a revised plan is explicitly authorized, run only that approved campaign sequentially with zero SDK retries. Stop on the first infrastructure/budget failure and leave later rows `Untested`.
7. Calculate p50/p95 only from operation-scoped production-app renderer acknowledgements for the pre-designated full-pipeline cases. A standalone/imported timing value or internal pipeline `total` is diagnostic and cannot satisfy release-to-visible acceptance.
8. Sign off M6 only if every gate passes within the newly authorized strict budget.

## Installer matrix

Use a non-production test account or VM for upgrade testing.

| Check | Result | Notes |
|---|---|---|
| Clean per-user install | Untested | |
| Installed application launches and helper reports ready | Untested | |
| Upgrade over the previous beta preserves settings/documents | Untested | |
| Uninstall removes binaries and shortcuts | Untested | |
| Uninstall preserves user data | Untested | |

## Capture matrix

Use the in-app Capture Status recorder and mirror results into `docs/capture-compatibility/matrix.md`. Every row requires an OFF control and an ON run. Accept only `overlay-absent`, `overlay-black`, `overlay-visible`, or `unsupported`; leave incomplete work as `untested`.
