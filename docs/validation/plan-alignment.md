# PresenterAI alignment with the milestone plan

Baseline reviewed: `C:\Users\kanut\Downloads\PLAN.md` on 2026-07-16.

PresenterAI remains on the chosen architecture: Electron 43 with React/TypeScript/Vite/Tailwind, a narrowly scoped self-contained .NET 8 Windows helper, system WASAPI loopback, local SQLite FTS5, sandboxed renderer IPC, main-process-only OpenAI access and secrets, `store:false`, listening OFF by default, and no telemetry, accounts, hosted backend, embeddings, process-tree Chrome capture, or continuous listening.

## Formal milestone standing

| Milestone | Standing against the original acceptance gate |
|---|---|
| M0 | Architecture, packaging, WASAPI, FTS5, and model spikes exist. Original Meet/OBS, transcription, and complete compatibility evidence remains unsigned. |
| M1 | Overlay shell and packaging exist. Required manual fullscreen/multi-monitor sign-off remains incomplete. |
| M2 | Honest requested/reported/manual-record semantics exist. Every required live capture-matrix row remains unsigned. |
| M3 | Accepted with its structured, no-invention, budget, and live Luna/Terra gates. |
| M4 | Accepted offline with 50/50 top-five recall and packaged Electron FTS5 evidence. |
| M5 | Source and automated gates pass; the real Meet/shortcut/device campaign is not accepted. |
| M6 | Source and automated gates pass; billable validation is safety-blocked because its documented worst case exceeds the immutable campaign cap. No M6 API request was made. |
| M7 | Source complete/offline green: the production SQLite FTS5/context/grounding evaluator passes 50/50. Formal live acceptance waits for M6 and separate spending authority. |
| M8 | Source complete/offline green. Repair PR #4 and post-merge `main` passed the full previous-main-to-current installer lifecycle and uploaded redacted evidence; formal acceptance still waits for M2–M7. |
| M9 | Not implemented and correctly remains experimental. |

No product release gate should be described as complete while M0–M2 remain unsigned. In particular, an installable source-level beta is not the same as the plan's accepted Manual Copilot MVP or personal beta.

The stored API key remains a main-process secret: the renderer can ask for status, save, test, replace, or delete it but cannot read it back. As necessarily occurs in any local settings form, a newly entered key exists transiently in the renderer password input before narrow IPC transfer; the implementation clears that input and does not retain the value in renderer state, logs, snapshots, or plaintext settings. This is consistent with the plan's security acceptance boundary and avoids the inaccurate stronger claim that user-entered material never exists in the renderer at all.

## Deliberate deviations and justification

| Deviation | Why it was necessary and how risk is contained |
|---|---|
| M5/M6 source implementation and some M7/M8 safety scaffolding preceded M0–M2 formal acceptance. | Parallel source work was explicitly authorized. It avoided idling development while manual Windows/Meet evidence required user assistance. Validation documents preserve dependency order and make no premature acceptance claim. |
| Helper protocol v2 adds operation IDs, readiness/features, terminal reasons, and rendered-frame acknowledgement. | The original protocol did not contain enough identity or timing data to prove race-safe capture, exactly one terminal path, or stop-to-visible latency. Renderer exposure remains semantic and narrow. |
| Listening is a press-on/press-off toggle rather than hold/release. | The user explicitly requested reusable toggle behavior after testing the hold interaction. Key-up remains restricted to rearming the native hook and suppressing autorepeat; system-output capture, visible listening state, consent, cancellation, and bounded recording limits are unchanged. |
| Audio transcription pauses at an editable draft instead of automatically generating an answer. | The user requested visibility and correction of speech-to-text mistakes. The WAV is still bounded and deleted immediately after transcription; the draft is memory-only, and explicit Ctrl+Enter submission reuses the ordinary typed retrieval/grounding path. This reduces accidental model calls and makes the user's final input auditable. |
| PresenterAI adds a persistent per-session USD cap and removes the INR converter. | OpenAI billing is denominated in USD, and the user requested a hard local safeguard. PresenterAI persists conservative holds before dispatch, blocks unknown requested models, retains uncertain holds, and resets only through New Session. It is explicitly not represented as account-level enforcement. |
| Programming creation requests can use structured code cards. | The user requested source code in separate ChatGPT-style containers. This remains one stateless Responses request with `store:false`, the accepted ordinary M3 schema and limits stay unchanged, code is strictly validated and rendered inert, and PresenterAI adds no execution, tools, web search, or code memory. |
| The overlay now defaults to a wider fixed dark-glass presentation without native acrylic. | The prior 560px shell compressed presenter content, native material obscured passthrough, and its rectangular shadow showed under curved CSS corners. A versioned bounds migration expands legacy windows; transparent CSS refractive glass retains crisp text, aligned clipping, reduced-transparency, and forced-colors fallbacks. This is presentation-layer hardening, not an architectural change. |
| Raw capture is bounded in helper memory and only the final 16 kHz mono WAV is written. | This is more private than the plan's permitted temporary raw sidecar while preserving its bounded transcription flow. The 90-second/128-MiB limits prevent unbounded memory use. |
| Terra Strong mode permits 1,200 total output tokens instead of 450. | Five accepted-gate requests exhausted 450 tokens on hidden reasoning and returned no visible structure. The strict visible schema still caps the presenter response, so the change fixes truncation without expanding visible output. Luna remains at 450. |
| Structured answers require exactly three key points although an early shared comment allowed 2–4. | Three bounded points were required to make the accepted M3 120–220 visible-word target enforceable through Structured Outputs. |
| The self-contained helper is bundled as an apphost plus runtime files rather than one physical executable. | Windows produced `spawn UNKNOWN` for the attempted single-file sidecar. Multi-file self-contained publishing avoids a machine-wide .NET dependency and remains isolated under `extraResources`. |
| M8 privacy, usage, device selection, shortcut validation, and unsigned packaging appeared before formal M8. | M5/M6 could not be operated or tested safely without explicit capture state, local usage accounting, endpoint visibility, cancellation/recovery controls, and transmission disclosures. They were scaffolding, not an M8 acceptance claim. The local clean installer lifecycle is green; the previous-main upgrade lifecycle remains a CI gate. |
| Packaged FTS/helper probes may use a controlled temporary NSIS installation when Smart App Control rejects direct unsigned `win-unpacked` execution. | The fallback neither disables nor bypasses Windows policy. It runs the exact packaged application/helper from the upstream NSIS installer, then uninstalls it. Clean `windows-latest` CI continues to exercise the direct unpacked path. |
| The earlier Windows-only static `app-builder-lib` uninstaller-extraction patch was removed. | Strict lifecycle testing showed the static extraction workaround was unnecessary and could yield an unreliable uninstall binary. PresenterAI now uses upstream electron-builder's intended two-pass NSIS generation; a controlled fully-initialized launch hook prevents the prior test race with late Electron/helper processes. |
| M6 billable validation did not run despite a lower practical estimate. | The provider endpoint exposes no caller-enforced transcription output-token cap. Its documented worst-case campaign cost exceeds the immutable $0.15 authorization, so fail-closed budget enforcement correctly spent $0. |
| Process-tree Chrome capture is unavailable rather than experimental in the product. | The original plan permits promotion only after a 19/20 isolation spike. That gate never passed, so reliable system WASAPI loopback remains the only supported source. |
| M7 and M8 were delivered as one commit instead of the planned two intentional commits. | This reduced milestone-level history clarity but did not change the reviewed architecture or runtime behavior. Do not rewrite merged history; keep subsequent repairs focused and document milestone evidence separately. |
| PR #3 was merged before its Windows check completed. | The post-merge workflow then reproduced the installer-harness failure. Future PRs must remain unmerged until `build-and-package` is green. Configure a required `main` status check when repository settings permit it; otherwise treat the same rule as a mandatory manual gate. |

No other material architectural deviation was found. Changes that strengthen validation, privacy, cancellation, or truthful status reporting while preserving the selected data flow are treated as implementation hardening rather than a change in product direction.

## Installer CI incident and recovery gate

PR [#3](https://github.com/KanuTomer/Presentation-Helper/pull/3) merged at `986469b`. Its [PR workflow](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29513275263) and [post-merge `main` workflow](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29513301865) both reached the installer upgrade scenario, downloaded the previous successful `main` artifact, and then timed out because the new harness expected the older application to write a result-file protocol that did not exist in that version. The current packaged FTS5 and helper probes had already passed, but the upgraded application and later Delete All/uninstall assertions were never reached.

The repair started from remote `main`, used legacy-observable readiness for the previous build, retained strict launch-result hooks for the current build, and produced redacted diagnostics even on failure. Repair PR run 29642064032 and post-merge `main` run 29642541009 both passed and published the installer, checksum manifest, and validation reports. The `dc1b609` artifact is therefore eligible for the narrow manual-mode technical preview; subsequent source changes require a new green workflow.

## Outstanding route to the planned beta

1. Permit only the closed manual-mode technical preview described in `docs/manual/manual-mode-technical-preview.md`; exclude independent audio and capture claims.
2. Complete the M0–M2 and M5 user-assisted Windows matrices; the M5/M6 automated source branch is already merged.
3. Resolve the M6 campaign budget with separate authority, then run its immutable live evidence set without retaining audio/transcripts/answers.
4. Keep M7 source/offline status separate from its later paid live gate; require follow-up resolution, unsupported-warning, contradiction, citation, and zero-invention thresholds unchanged.
5. Keep M8 source/offline status separate from formal acceptance until every M2–M7 predecessor is accepted.
6. Leave M9 disabled unless its independent privacy, reliability, cost, and promotion criteria are later authorized and met.

## Branch evidence

- M7 offline: 50/50 cases, 20/20 contextual follow-ups, 50/50 production FTS selections, zero failed IDs.
- Current beta.2 local regression: Vitest 353/353 in 50 files, .NET 33/33 in the latest isolated run, Playwright 9/9, M4 50/50, M7 50/50, M6 preflight zero network requests, and audit zero vulnerabilities. Strict local two-cycle WASAPI and packaged probes ran after reputation evaluation. GitHub-hosted run 29908576569 exposed no render endpoint, so CI uses the published helper's dual-gated deterministic backend for two full process/protocol cycles and reports `wasapiCaptureValidated: false`; it never labels hosted physical capture successful. Smart App Control has blocked unsigned local payloads and the local installer lifecycle; M5/M6 are not accepted.
- Packaged runtime: Electron 43.1.0, SQLite 3.53.1 FTS5, helper protocol v2 with nine required features.
- Local clean installer lifecycle: passed against SHA-256 `86F089B077221C38FB37C7739882D4C9854A72E91FA85D76FD3B1DD630C2AF27`.
- M7/M8 PR #3 merged at `986469b`, but its PR and post-merge installer gates failed before upgrade validation because the legacy build lacked the new launch-result hook.
- Repair PR workflow [29642064032](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642064032) and post-merge `main` workflow [29642541009](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642541009): green, with lifecycle `ok=true`, exact previous-baseline provenance, installer/checksum match, M7/M8 records, and clean/upgraded payload removal.

Repair PR #4 has supplied two useful failing-gate results without changing milestone acceptance. The first proved legacy-compatible initialization and genuine upgrade before exposing a Delete All maintenance self-lock; the second proved the corrected eight-scope Delete All path before a recursive file-enumeration race aborted the NSIS cleanup poll roughly three seconds into its 60-second allowance. The harness now treats only `ENOENT` for a concurrently vanished root or subtree as empty, continues polling any actual residual payload, propagates access and other filesystem errors, and records bounded uninstall progress. This is test hardening, not a product-architecture deviation.
