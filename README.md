# PresenterAI

PresenterAI is a private, local-first Windows presentation copilot. It runs as a minimal Electron overlay, indexes presentation documents locally, sends only selected context to OpenAI, and can capture a bounded segment of system output audio through a small Windows helper.

## Current implementation

- Frameless, always-on-top 1100px transparent overlay with CSS-rendered refractive dark glass, clipped rounded corners, one reliable content scroller, accessibility fallbacks, click-through, hide/show, tray controls, and migrated persisted bounds.
- Windows capture-exclusion request through Electron `setContentProtection(true)`, with status and a visual capture-test pattern.
- Sandboxed/context-isolated renderer and narrow, validated IPC surface.
- OpenAI Responses API with `store:false`, structured presenter output, local rolling context, cancellation, and grounded-evidence validation. Programming creation requests can return inert, copy-only structured code cards without enabling model tools or code execution.
- DPAPI-backed API-key encryption through Electron `safeStorage`; the renderer never receives the stored key.
- Local PPTX, PDF, Markdown, and text parsing with SQLite FTS5 retrieval.
- Self-contained C#/.NET 8 WASAPI loopback helper with protocol-v2 operation IDs, bounded in-memory capture, output-device selection, 16 kHz mono PCM finalization, restricted Ctrl+Shift+Space toggle detection, health reporting, and one idle restart. Capture is system output only; PresenterAI does not request microphone audio.
- One application-wide typed/audio operation coordinator, bounded transcription through `gpt-4o-mini-transcribe`, editable memory-only transcript review, operation-scoped cancellation, temporary-file cleanup before draft display, and a persistent conservative USD session cap (default `$0.25`).

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
npm audit --audit-level=high
npm run verify
npm run eval:m4
npm run eval:m6:preflight
npm run eval:m7
npm run helper:build
npm run test:helper-smoke
npm run test:e2e
npm run package:win
npm run test:packaged-fts
npm run test:packaged-helper
npm run test:code-integrity-environment
npm run test:installer:upgrade -- --previous "<path-to-previous-successful-main-installer>"
```

Milestone 3 is accepted: the mocked safety suite and budget-bounded local live-model gate passed for both Normal and Strong modes. The redacted acceptance record is in [docs/validation/milestone-3.md](docs/validation/milestone-3.md); raw prompts, responses, and credentials are not retained.

Milestone 4 is accepted offline: the versioned 50-case corpus reached 50/50 top-five recall, and the clean Windows CI runner built the installer and passed the packaged SQLite FTS5 probe. See [docs/validation/milestone-4.md](docs/validation/milestone-4.md) for the redacted gate record. This validation does not use OpenAI or consume API credits.

Milestones 5 and 6 have completed their source/offline implementation work. The beta.2 branch passes 352/352 Vitest tests in 50 files, 33/33 .NET tests, 9/9 Playwright Electron tests, a clean high-severity dependency audit, and the accepted 50/50 M4 retrieval corpus. A strict two-cycle local WASAPI smoke produced valid 16 kHz mono captures, and the packaged FTS/helper probes passed after Windows completed its reputation scan. GitHub-hosted Windows runners expose no render endpoint, so CI runs the same published helper executable through two full protocol/finalization cycles using a dual-gated deterministic test backend and reports `wasapiCaptureValidated: false`; it never claims physical WASAPI passed. Code Integrity has also blocked unsigned local payloads (`0x800711C7`) and the local installer lifecycle timed out, so these isolated local runs do not clear the native acceptance gate. Formal M5/M6 acceptance remains blocked by the M0–M2 capture/fullscreen prerequisites and the user-assisted physical/Meet campaign.

The M6 live campaign is additionally safety-blocked before any network request. The current repair-branch preflight estimates **$0.148247**, but its documented model limits produce a **$0.644547** worst-case bound, which cannot satisfy the immutable **$0.15** cap. The preflight therefore reports `strictCampaignFeasible=false` and `billableExecutionEnabled=false`; M6 has spent **$0**. A separate user decision must revise the case count or cap before paid validation can run. See [docs/validation/milestone-5.md](docs/validation/milestone-5.md) and [docs/validation/milestone-6.md](docs/validation/milestone-6.md).

Milestone 7 is source complete and offline green at 50/50 deterministic cases. Milestone 8 is source complete/offline green, and its repaired cross-version installer lifecycle passed on both PR #4 and post-merge `main`. Neither milestone is formally accepted: M7 still depends on M6 and a separately authorized live evaluation, while M8 depends on M2–M7. See [docs/validation/milestone-7.md](docs/validation/milestone-7.md), [docs/validation/milestone-8.md](docs/validation/milestone-8.md), and [docs/validation/plan-alignment.md](docs/validation/plan-alignment.md).

PR [#3](https://github.com/KanuTomer/Presentation-Helper/pull/3) merged the M7/M8 source at commit `986469b`. Its PR and post-merge Windows workflows failed in the installer lifecycle because the harness tried to use a launch-result hook that the older baseline installer could not implement. That failure occurred before the upgraded application, Delete All, final uninstall, or artifact upload could be validated; it is not evidence that those later checks passed or that the current packaged application failed to launch. Do not distribute an installer from either failed workflow.

Repair PR [#4](https://github.com/KanuTomer/Presentation-Helper/pull/4) initializes the legacy build through observable local state and retains strict result-file hooks for current builds. Its first Windows run exposed and led to a fix for a Delete All maintenance self-lock. Its second run exposed a harness race while NSIS was concurrently removing the installation tree. The final repair tolerates only a disappearing-path `ENOENT`, continues polling real residual files to the deadline, and keeps complete payload removal strict. [Repair run 29642064032](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642064032) and [post-merge main run 29642541009](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642541009) both passed the complete lifecycle; the main run uploaded the installer, checksum manifest, M7/M8 records, and redacted lifecycle diagnostics.

The unsigned per-user NSIS installer is written to `release/`. Uninstalling it does not remove PresenterAI documents or settings. Windows Smart App Control or enterprise Code Integrity may refuse to launch a newly rebuilt unsigned executable; code signing remains outside this milestone and security controls must not be disabled. The beta.2 installer is not eligible for preview until its branch and post-merge `build-and-package` workflows are green. The artifact from green `main` run 29642541009 remains the latest eligible closed manual-mode technical preview in the meantime. No public release is created.

## Privacy model

- Listening starts OFF on every launch.
- System audio is accumulated in bounded helper memory during capture. Only the finalized 16 kHz mono WAV is written to a PresenterAI-owned temporary path, and it is deleted by the transcription stage before an editable draft is displayed.
- Transcripts remain only in renderer memory. Retrieval and answer generation begin only after the user reviews the draft and submits the composer with Ctrl+Enter.
- The active USD session ledger survives restart. Clear Usage does not reset it; only New Session starts a new allowance. This is a PresenterAI-side control, not an OpenAI account billing limit.
- Full source documents remain local. Up to five retrieved excerpts are included in a normal reasoning request.
- No analytics, telemetry, user account, hosted backend, or cloud database exists.
- Bounded audio and selected document excerpts leave the computer when their respective API operations run. OpenAI's current endpoint table reports no application-state or abuse-monitoring retention for audio transcription, while ordinary Responses API abuse-monitoring retention may still apply. See [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint).

## Capture compatibility

Complete the checklist in [docs/capture-compatibility/matrix.md](docs/capture-compatibility/matrix.md) on every target Windows/Electron/Chrome/OBS combination. A successful API call is not equivalent to verified exclusion.

Complete the physical-device and Meet checks in [docs/manual/windows-beta-validation.md](docs/manual/windows-beta-validation.md) before treating a build as a validated beta.

After a green post-repair `main` workflow, a trusted tester may follow the narrower [manual-mode technical-preview guide](docs/manual/manual-mode-technical-preview.md). That preview covers typed questions, local documents, grounding, settings, and privacy controls only; it is not an independent audio or capture-protection validation.
