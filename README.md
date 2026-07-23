# PresenterAI

PresenterAI is a private, local-first Windows copilot for presentations, technical reviews, and coding discussions. It stays above the application you are presenting, retrieves supporting details from your local documents, and produces concise answers or copyable code without sending an entire document to the model.

> PresenterAI is an unsigned development beta for Windows 11 x64. Capture exclusion and system-audio reliability still require validation on each target setup.

## What it does

- Starts in **Code** mode with structured, copyable source-code cards; **Presenter** mode produces short, natural answers designed to be spoken aloud.
- Indexes PPTX, PDF, Markdown, and UTF-8 text locally with SQLite FTS5 and sends only selected evidence chunks to OpenAI.
- Captures bounded **Windows system output**, not microphone audio, through a restricted .NET helper. The transcript is shown as an editable draft before it can be submitted.
- Keeps the OpenAI key in Electron `safeStorage` (Windows DPAPI), keeps conversation state local, and sends Responses requests with `store:false`.
- Provides a transparent always-on-top overlay, tray controls, configurable shortcuts, fail-closed click-through recovery, and a persistent per-session USD cap.
- Makes no telemetry, analytics, account, cloud-database, or hosted-backend connection.

## How it works

1. **Set up** — add an OpenAI API key in Settings and optionally import presentation documents.
2. **Ask** — type a question, or toggle system-audio capture and review the resulting transcript.
3. **Generate** — choose Code or Presenter and submit with `Ctrl+Enter`; PresenterAI retrieves up to five relevant local chunks.
4. **Review** — read the answer, copy code, and inspect the evidence or warning before speaking.

## Run locally

### Requirements

- Windows 11 x64
- [Node.js 22 or newer](https://nodejs.org/)
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) for the system-audio helper
- An OpenAI API key for transcription or generated answers

### Install and start

```powershell
git clone https://github.com/KanuTomer/Presentation-Helper.git
cd Presentation-Helper
npm ci
npm run helper:build
npm run dev
```

On first run:

1. Open **Settings**, save the API key, and use the connection test.
2. Open **Documents** to import non-sensitive PPTX, PDF, Markdown, or text fixtures.
3. Review and accept the listening disclosure before the first system-audio capture.
4. Confirm that listening is off and test `Ctrl+Shift+I` before enabling click-through.
5. Type a question in **Copilot** and press `Ctrl+Enter`.

The typed/document workflow still runs if the helper is unavailable; only system-audio controls are disabled.

## Shortcuts

| Action | Default |
|---|---|
| Focus the composer | `Ctrl+Space` |
| Hide or show PresenterAI | `Ctrl+Shift+H` |
| Start or stop system-audio capture | `Ctrl+Shift+Space` |
| Restore interaction after click-through | `Ctrl+Shift+I` |
| Submit the reviewed question | `Ctrl+Enter` |
| Cancel the active operation | `Esc` |

Ask, hide/show, and listening shortcuts can be changed in Settings. `Ctrl+Shift+I` is fixed so click-through always has a known recovery path; **Tray → Show PresenterAI** is the second recovery method.

## Build the Windows installer

```powershell
npm run package:win
```

The command builds the helper and Electron application, creates the unsigned NSIS installer under `release/`, and writes `SHA256SUMS.txt`. Windows SmartScreen, Smart App Control, or an organization’s App Control policy may block unsigned binaries. Do not disable Windows security to run PresenterAI; use a trusted development environment or a future signed build.

## Development checks

The standard offline gate does not call OpenAI:

```powershell
npm audit --audit-level=high
npm run verify
npm run eval:m4
npm run eval:m6:preflight
npm run eval:m7
npm run test:e2e
```

Native and packaged checks:

```powershell
npm run test:helper-smoke
npm run package:win
npm run test:packaged-fts
npm run test:packaged-helper
npm run test:code-integrity-environment
```

Live evaluation scripts are opt-in, billable, and excluded from ordinary development and CI.

## Privacy and limitations

- Source documents and the FTS index stay on the computer. Only the current question, bounded local context, and selected evidence chunks are sent for an answer.
- System audio is captured in bounded helper memory. A final temporary WAV is deleted after transcription, and the transcript remains an editable in-memory draft until submission.
- The local USD cap limits PresenterAI requests, not the OpenAI account itself. Provider billing remains authoritative.
- DPAPI primarily protects the stored key from other Windows users; it cannot isolate it from every process already running as the same user.
- The transcription endpoint and Responses API have different retention rules. Review the current [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data) before using sensitive material.
- Image-only/scanned files, visual chart interpretation, OCR, Chrome-process audio isolation, microphone capture, continuous listening, and automatic screenshots are not supported.
- `setContentProtection(true)` is requested on Windows, but that is not a universal security guarantee. Record every capture application/version in the [compatibility matrix](docs/capture-compatibility/matrix.md).

## Validation status

| Area | Current standing |
|---|---|
| [M0–M2: Windows shell and capture protection](docs/validation/milestones-0-2.md) | Implemented; fullscreen, multi-monitor, Meet, OBS, and capture-path matrices remain unsigned. |
| [M3: typed presenter answers](docs/validation/milestone-3.md) | The accepted Luna/Terra report remains historical evidence. The natural spoken-delivery prompt is offline-green and awaits a separately authorized live revalidation. |
| [M4: document retrieval](docs/validation/milestone-4.md) | Accepted offline at 50/50 top-five recall with packaged Electron FTS5. |
| [M5–M6: capture and transcription](docs/validation/milestone-5.md) | Source and automated checks are green; physical device/Meet and billable live acceptance remain pending. |
| [M7: context and grounding](docs/validation/milestone-7.md) | Source complete and offline green at 50/50; formal live acceptance remains pending. |
| [M8: privacy, settings, and packaging](docs/validation/milestone-8.md) | Source complete/offline green; formal acceptance depends on M2–M7. |
| M9: continuous listening | Not implemented and remains experimental. |

See the [plan alignment record](docs/validation/plan-alignment.md), [beta.4 clear-glass record](docs/validation/clear-glass-compact-copilot.md), and [closed technical-preview guide](docs/manual/manual-mode-technical-preview.md) for the exact acceptance boundaries.

## Safety boundary

PresenterAI is intended for presentations and reviews where its use is permitted and disclosed. It does not include stealth activation, proctoring or examination evasion, hidden collaboration, process-tree browser capture, or claims of being “undetectable.”
