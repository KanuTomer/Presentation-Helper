# Milestone 6 transcription-to-response validation record

Status: **NOT ACCEPTED — automated gate passed; live validation is safety-blocked by the strict budget and Milestone 5/manual prerequisites.**

This gate reuses the immutable 20 audio captures designated in the M5 campaign. It validates bounded transcription into an editable, acknowledged renderer draft, followed by explicit user submission through M4 retrieval and one M3-compatible Responses request. No retrieval or Responses dispatch occurs before that submission. It does not evaluate Terra, Realtime transcription, diarization, continuous listening, or process-specific capture.

## Budget and privacy controls

- Model: `gpt-4o-mini-transcribe`; answer mode: Normal/Luna only.
- Lifetime M6 live cap: **$0.15**; SDK retries: **zero**.
- The paid validation corpus uses short reviewer questions and rejects clips over **20 seconds before upload**. That reduces the practical estimate but cannot create a strict provider-token ceiling; the product's separate M5 capture bound remains 90 seconds.
- M3's historical evaluation report recorded **$0.206648**. This M6 campaign has made **zero network requests and spent $0**; PresenterAI does not inspect or claim the provider account's current balance, which may reflect unrelated usage.
- Stop before each request if conservative projected spend would exceed the cap.
- Product sessions additionally default to a persistent `$0.25` cap. A conservative reservation is written before dispatch; missing usage or an unpriced returned model retains the full hold. That product control does not authorize this separate live campaign.
- Stop on authentication, quota, rate-limit, timeout, network, or budget failure; do not rerun automatically.
- Persist only case IDs, pass/fail flags, model IDs, timings, token usage, price-version metadata, estimated cost, and failed IDs.
- Never persist credentials, audio, transcripts, prompts, answers, or reasoning content.

Latest offline preflight: 2026-07-18, 20-case corpus / 10 full-pipeline cases, **zero network requests**.

- Practical projected estimate: **$0.148247**.
- Documented worst-case bound: **$0.644547**.
- Immutable live cap: **$0.15**.
- `strictCampaignFeasible=false`.
- `billableExecutionEnabled=false`.

The current [model specification](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe) permits up to 2,000 output tokens and lists token pricing; the transcription request does not expose a smaller caller-controlled output-token ceiling. The resulting documented worst case exceeds the cap, so the evaluator refuses billable execution before making a request. A separate user decision must revise the case count or cap; an estimate below $0.15 is not sufficient authority to spend.

Bounded audio is transmitted to the transcription endpoint and selected M4 context is transmitted to Responses for the ten full-pipeline cases. OpenAI's current [data-controls table](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint) reports no application-state or abuse-monitoring retention for audio transcription; ordinary Responses API abuse-monitoring rules can still apply.

## Automated evidence

| Case ID | Gate | Result | Evidence / notes |
|---|---|---|---|
| M6-AUTO-01 | Typed and audio operations cannot overlap; Busy remains distinct | Pass | Shared coordinator and UI tests |
| M6-AUTO-02 | One operation ID/cancellation signal spans every stage | Pass | Coordinator/controller tests |
| M6-AUTO-03 | Cancellation at each boundary prevents later stages/stale updates | Pass | Deterministic boundary and race tests |
| M6-AUTO-04 | Upload accepts only owned, bounded, valid 16 kHz mono PCM WAVs | Pass | Byte-level ownership/RIFF/format/duration/size tests |
| M6-AUTO-05 | Transcript normalization rejects empty/control-only/>4,000 characters | Pass | Transcription validation tests |
| M6-AUTO-06 | Hint is deduplicated and bounded from approved vocabulary/doc titles | Pass | Vocabulary/settings/transcription tests |
| M6-AUTO-07 | WAV is deleted in transcription `finally`, before transcript display | Pass | Pipeline cleanup-order and failure tests |
| M6-AUTO-08 | No retrieval/Responses request occurs until the reviewed draft is submitted; then exactly one Responses request classifies and answers | Pass | Controller, composer, and request-shape tests; `store:false` preserved |
| M6-AUTO-09 | Only selected M4 chunks are sent; citations remain validated | Pass | Cross-reference accepted `milestone-4.md`; context/citation tests remain green |
| M6-AUTO-10 | Stage timings/usage contain no audio, transcript, prompt, or answer | Pass | Timing/usage/redaction tests and offline report scan |

Aggregate beta.2 non-billable evidence: 353 Vitest tests in 50 files, 33/33 .NET tests in the latest isolated run, 9/9 Playwright Electron tests, zero dependency vulnerabilities, accepted 50/50 M4 retrieval, and a zero-network M6 preflight. Code Integrity has blocked unsigned local payloads and the local installer lifecycle. GitHub CI uses a dual-gated deterministic helper backend for two complete process/protocol cycles and reports that this does not validate WASAPI; physical system-audio and live transcription acceptance remain pending. No live M6 API request was made.

## Renderer-visible latency evidence

Stop-to-visible-answer acceptance must use the production app's operation-scoped renderer frame acknowledgement. An imported or manually entered standalone timing value is not bound strongly enough to the same audio operation and therefore cannot close the p50/p95 gate by itself. During the user-assisted campaign, transiently verify that the acknowledgement belongs to the active operation, then persist only its case ID and timing. Internal pipeline `total` timing remains diagnostic only. Legacy reports using release-oriented timing field names are migrated when read; all new reports emit stop-oriented names.

## Live twenty-case transcription campaign

Human meaning review is transient. Record only the outcome flag; do not copy transcript or answer text into this file.

| Case ID | M5 trial | Structured | Meaning correct | Continued E2E | Transcription ms | Retrieval ms | Generation ms | Internal total ms | Stop→visible ms | Temp gone | Tokens / cost | Result |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---|---|---|
| M6-LIVE-01–20 | | | | | | | | | | | | Untested |

Designate exactly ten cases for the complete transcription-to-answer path before starting the campaign. The other ten stop after transcription and deletion verification.

## Acceptance calculations

- Valid structured transcription results: ___/20; required 20/20.
- Correct reviewer-question meaning: ___/20; required at least 18/20.
- Complete E2E cases: ___/10; required 10/10 terminal outcomes.
- Stop-to-visible-answer p50: ___ ms; required ≤5,000 ms.
- Stop-to-visible-answer p95: ___ ms; required ≤8,000 ms.
- Temporary WAV absent after all outcomes: ___/20; required 20/20.
- Actual estimated spend: $___; required ≤$0.15.
- Failed/blocking case IDs:
- Human sign-off / date:
- Decision: **Blocked before billable execution; $0 spent**
