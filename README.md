# PresenterAI

PresenterAI is a private, local-first Windows presentation copilot. It runs as a minimal Electron overlay, indexes presentation documents locally, sends only selected context to OpenAI, and can capture a bounded segment of system output audio through a small Windows helper.

## Current implementation

- Frameless, transparent, always-on-top overlay with opacity, click-through, hide/show, tray controls, and persisted bounds.
- Windows capture-exclusion request through Electron `setContentProtection(true)`, with status and a visual capture-test pattern.
- Sandboxed/context-isolated renderer and narrow, validated IPC surface.
- OpenAI Responses API with `store:false`, structured presenter output, local rolling context, cancellation, and grounded-evidence validation.
- DPAPI-backed API-key encryption through Electron `safeStorage`; the renderer never receives the stored key.
- Local PPTX, PDF, Markdown, and text parsing with SQLite FTS5 retrieval.
- C#/.NET 8 WASAPI loopback helper source with restricted Ctrl+Shift+Space key-down/key-up detection.
- Bounded transcription through `gpt-4o-mini-transcribe`, temporary-file cleanup, privacy disclosure, and local cost estimates.

Application-specific Chrome process-tree capture and continuous listening remain disabled until their experimental gates are validated. Capture protection is never presented as a universal guarantee.

## Development

Requirements:

- Windows 11 x64
- Node.js 22 or newer
- .NET 8 SDK for the audio helper

```powershell
npm install
npm run helper:build
npm run dev
```

Without the .NET helper, the manual document-grounded copilot works normally; audio controls report that the helper is unavailable.

Verification:

```powershell
npm run typecheck
npm test
npm run build
npm run package:win
```

## Privacy model

- Listening starts OFF on every launch.
- Raw audio is written only to a PresenterAI temporary path while a bounded transcription is active and is deleted on success, failure, cancellation, exit, or stale-startup cleanup.
- Full source documents remain local. Up to five retrieved excerpts are included in a normal reasoning request.
- No analytics, telemetry, user account, hosted backend, or cloud database exists.
- API requests still leave the computer and are subject to OpenAI API data policies.

## Capture compatibility

Complete the checklist in [docs/capture-compatibility/matrix.md](docs/capture-compatibility/matrix.md) on every target Windows/Electron/Chrome/OBS combination. A successful API call is not equivalent to verified exclusion.
