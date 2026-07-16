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
| M8 | Source complete/offline green, with a passing local clean install/launch/uninstall lifecycle. Formal acceptance waits for M2–M7 and the mandatory CI previous-main upgrade lifecycle. |
| M9 | Not implemented and correctly remains experimental. |

No product release gate should be described as complete while M0–M2 remain unsigned. In particular, an installable source-level beta is not the same as the plan's accepted Manual Copilot MVP or personal beta.

The stored API key remains a main-process secret: the renderer can ask for status, save, test, replace, or delete it but cannot read it back. As necessarily occurs in any local settings form, a newly entered key exists transiently in the renderer password input before narrow IPC transfer; the implementation clears that input and does not retain the value in renderer state, logs, snapshots, or plaintext settings. This is consistent with the plan's security acceptance boundary and avoids the inaccurate stronger claim that user-entered material never exists in the renderer at all.

## Deliberate deviations and justification

| Deviation | Why it was necessary and how risk is contained |
|---|---|
| M5/M6 source implementation and some M7/M8 safety scaffolding preceded M0–M2 formal acceptance. | Parallel source work was explicitly authorized. It avoided idling development while manual Windows/Meet evidence required user assistance. Validation documents preserve dependency order and make no premature acceptance claim. |
| Helper protocol v2 adds operation IDs, readiness/features, terminal reasons, and rendered-frame acknowledgement. | The original protocol did not contain enough identity or timing data to prove race-safe hold/release, exactly one terminal path, or release-to-visible latency. Renderer exposure remains semantic and narrow. |
| Raw capture is bounded in helper memory and only the final 16 kHz mono WAV is written. | This is more private than the plan's permitted temporary raw sidecar while preserving its bounded transcription flow. The 90-second/128-MiB limits prevent unbounded memory use. |
| Terra Strong mode permits 1,200 total output tokens instead of 450. | Five accepted-gate requests exhausted 450 tokens on hidden reasoning and returned no visible structure. The strict visible schema still caps the presenter response, so the change fixes truncation without expanding visible output. Luna remains at 450. |
| Structured answers require exactly three key points although an early shared comment allowed 2–4. | Three bounded points were required to make the accepted M3 120–220 visible-word target enforceable through Structured Outputs. |
| The self-contained helper is bundled as an apphost plus runtime files rather than one physical executable. | Windows produced `spawn UNKNOWN` for the attempted single-file sidecar. Multi-file self-contained publishing avoids a machine-wide .NET dependency and remains isolated under `extraResources`. |
| M8 privacy, usage, device selection, shortcut validation, and unsigned packaging appeared before formal M8. | M5/M6 could not be operated or tested safely without explicit capture state, local usage accounting, endpoint visibility, cancellation/recovery controls, and transmission disclosures. They were scaffolding, not an M8 acceptance claim. The local clean installer lifecycle is green; the previous-main upgrade lifecycle remains a CI gate. |
| Packaged FTS/helper probes may use a controlled temporary NSIS installation when Smart App Control rejects direct unsigned `win-unpacked` execution. | The fallback neither disables nor bypasses Windows policy. It runs the exact packaged application/helper from the upstream NSIS installer, then uninstalls it. Clean `windows-latest` CI continues to exercise the direct unpacked path. |
| The earlier Windows-only static `app-builder-lib` uninstaller-extraction patch was removed. | Strict lifecycle testing showed the static extraction workaround was unnecessary and could yield an unreliable uninstall binary. PresenterAI now uses upstream electron-builder's intended two-pass NSIS generation; a controlled fully-initialized launch hook prevents the prior test race with late Electron/helper processes. |
| M6 billable validation did not run despite a lower practical estimate. | The provider endpoint exposes no caller-enforced transcription output-token cap. Its documented worst-case campaign cost exceeds the immutable $0.15 authorization, so fail-closed budget enforcement correctly spent $0. |
| Process-tree Chrome capture is unavailable rather than experimental in the product. | The original plan permits promotion only after a 19/20 isolation spike. That gate never passed, so reliable system WASAPI loopback remains the only supported source. |

No other material architectural deviation was found. Changes that strengthen validation, privacy, cancellation, or truthful status reporting while preserving the selected data flow are treated as implementation hardening rather than a change in product direction.

## Outstanding route to the planned beta

1. Complete the M0–M2 and M5 user-assisted Windows matrices; the M5/M6 automated source branch is already merged.
2. Resolve the M6 campaign budget with separate authority, then run its immutable live evidence set without retaining audio/transcripts/answers.
3. Keep M7 source/offline status separate from its later paid live gate; require follow-up resolution, unsupported-warning, contradiction, citation, and zero-invention thresholds unchanged.
4. Keep M8 source/offline status separate from formal acceptance until every M2–M7 predecessor is accepted.
5. Leave M9 disabled unless its independent privacy, reliability, cost, and promotion criteria are later authorized and met.

## Branch evidence

- M7 offline: 50/50 cases, 20/20 contextual follow-ups, 50/50 production FTS selections, zero failed IDs.
- Full regression: Vitest 259/259, .NET 29/29, Playwright 5/5, M4 50/50, audit zero vulnerabilities.
- Packaged runtime: Electron 43.1.0, SQLite 3.53.1 FTS5, helper protocol v2 with nine required features.
- Local clean installer lifecycle: passed against SHA-256 `86F089B077221C38FB37C7739882D4C9854A72E91FA85D76FD3B1DD630C2AF27`.
- M7/M8 PR, mandatory previous-main upgrade lifecycle, post-merge workflow, and uploaded artifacts remain the publication gate.
