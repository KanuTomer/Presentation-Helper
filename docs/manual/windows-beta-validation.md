# Windows beta validation

Do not infer any result from the protection request or Electron's reported state. Record exact versions and test protection OFF before protection ON.

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
