# Milestone 8 secure settings, privacy, and cost-control record

Status: **SOURCE COMPLETE / OFFLINE GREEN; LOCAL CLEAN-INSTALL LIFECYCLE GREEN — formal acceptance remains dependent on Milestones 2–7 and the CI upgrade lifecycle.**

This milestone makes repeated personal use safer and more understandable. It does not add telemetry, accounts, cloud synchronization, automatic exchange-rate lookup, code signing, auto-update, or a public release. Listening still starts OFF on every launch.

## Implemented controls

- Stored settings use a versioned, strictly validated schema with deterministic migration from the prior unversioned format. Invalid persisted fields fall back safely and produce a local recovery warning.
- Shortcut entry records the supported Windows accelerator subset. `Esc` cancels recording, modifier-only and unsupported keys are rejected, all configurable shortcuts are applied transactionally, and `Ctrl+Shift+I` remains reserved for emergency interaction recovery.
- The API-key status returned from storage exposes configuration/protection metadata only; it never returns key material or suffixes. A key newly typed by the user exists transiently in the renderer's password input, is sent through the narrow save-key IPC method, is immediately cleared from that input, and is not retained in React state, logs, snapshots, or plaintext settings. Privacy copy explains that Windows DPAPI primarily protects against other Windows users, not every process already running as the same user.
- Hold-to-listen requires a versioned first-use acknowledgement through every capture entry point. A missing acknowledgement opens Privacy and prevents capture rather than merely warning after capture begins.
- An operation-scoped preview is painted and acknowledged before each external transmission. The transcription preview describes the bounded audio and terminology hint; the response preview shows the exact selected evidence chunks and bounded background categories. The transcript never enters renderer state.
- Preview acknowledgements use operation ID and stage. A stale acknowledgement is ignored; failure to acknowledge within two seconds fails closed before network dispatch.
- Usage is recorded as bounded per-request metadata, with exact requested/returned model IDs, endpoint, supported token fields, duration, price version, and priced/unpriced status. The newest 100 records remain inspectable and older records roll into aggregate model/endpoint totals.
- Unknown exact model IDs remain visibly unpriced. Optional INR display uses only a user-entered exchange rate and is clearly approximate.
- Independent controls clear conversation context, usage estimates, capture compatibility records, the local document catalog/index, and encrypted API-key ciphertext.
- Delete-all requires an idle application and exact `DELETE ALL` confirmation. Its service reports per-scope failures, resets PresenterAI settings, clears the local index/catalog and other application-owned state, removes encrypted key files and PresenterAI-owned temporary WAVs, and never targets the user's original source documents. The production deletion service is covered directly and through the restricted packaged smoke hook; the previous-main upgrade/delete-all lifecycle remains a required Windows CI assertion.

## Privacy boundary

PresenterAI sends data only after an explicit typed request or acknowledged hold-to-listen operation. Responses use `store:false`; the application creates no OpenAI Conversation and stores no cloud meeting history. Bounded WAV data is deleted locally when transcription reaches a terminal state, before retrieval or response generation.

The in-product disclosure follows OpenAI's current [data-controls documentation](https://developers.openai.com/api/docs/guides/your-data): ordinary Responses API abuse-monitoring retention can still apply, while the published endpoint table currently lists no application-state or abuse-monitoring retention for audio transcription. API content is not used for model training unless the customer opts in. These provider statements are version-sensitive and must be rechecked before each release.

## Offline verification

The committed deterministic tests and test harnesses are intended to cover:

- Legacy and corrupt settings migration, strict renderer-patch validation, and recovery warnings.
- Keyboard recording, key normalization, autorepeat, `Esc`, unsupported keys, emergency reservation, conflict rollback, and restoring all defaults in one transaction.
- Consent versioning and capture blocking from buttons, the global shortcut, and helper shortcut events.
- Preview ordering, first-frame acknowledgement, timeout, cancellation, stale operations, and proof that no upload/generation starts first.
- Per-model usage pricing, reasoning/audio token accounting, incomplete responses, unknown model snapshots, bounded history rollover, INR estimates, and clearing.
- Every retention scope, partial failures, no FTS orphans, key/temp cleanup, original-source preservation, and active-operation rejection. Packaged relaunch and post-delete persistence must be proven by the final installer lifecycle gate.
- Renderer accessibility and error states for consent, shortcut recording, preview, usage, and destructive confirmation.
- Clean current install, isolated launch, previous-successful-main upgrade, settings/index preservation, uninstall binary removal, packaged delete-all, and user-data/source-document preservation. These are requirements of the installer script/workflow, not recorded passing evidence until the final Windows run succeeds.

The final local branch gate completed on 2026-07-16. Smart App Control intermittently rejected direct unsigned `win-unpacked` launches, so the packaged probes fail closed to a controlled temporary NSIS installation rather than disabling or bypassing Windows policy. The clean installer lifecycle uses the same upstream electron-builder NSIS output, waits for full application initialization and graceful cleanup, proves complete binary removal, and proves that PresenterAI data and the user's source document survive uninstall.

The local machine does not provide a previous successful `main` installer baseline to the script. The workflow therefore remains responsible for the mandatory previous-main upgrade, packaged delete-all, post-delete persistence, and second uninstall checks. Missing baseline evidence fails CI rather than becoming a skipped pass.

| Gate | Result |
|---|---|
| TypeScript and full Vitest suite | Passed; 39 files, 259/259 tests |
| M3 and M4 regression suites | Passed; M4 top-five recall 50/50 |
| M6 offline budget preflight | Passed without network dispatch; campaign remains correctly infeasible under the immutable cap |
| M7 50-case offline evaluator | Passed 50/50 with zero failed IDs |
| .NET helper tests and WASAPI smoke | 29/29; protocol v2, two devices, valid 16 kHz mono WAV |
| Playwright Electron suite | Passed 5/5 |
| Production Electron/NSIS packaging | Passed with Electron 43.1.0 and upstream electron-builder 26.15.3 |
| Packaged FTS5/helper probes | SQLite 3.53.1 FTS5 passed; helper protocol v2 with nine required features passed |
| Installer clean launch/uninstall probe | Passed; full initialization, seeded-data preservation, complete payload removal |
| Previous-main upgrade/delete-all/uninstall probe | Pending mandatory Windows CI baseline run |
| Credential/generated-artifact/redaction scans | Pending final staged/publication scan |

## Formal acceptance blockers

Milestone 8 depends on Milestones 2–7 in the original plan. The capture-protection matrix, physical-device/manual M5 campaign, budget-blocked M6 live campaign, and separately authorized M7 live model evaluation remain incomplete. Consequently this record may say **source complete/offline green** after the branch gate, but must not say that the personal beta or Milestone 8 is formally accepted.

## Branch evidence

- Gate date: 2026-07-16; commit: the commit containing this record.
- Final installer: `PresenterAI-0.1.0-setup.exe`, SHA-256 `86F089B077221C38FB37C7739882D4C9854A72E91FA85D76FD3B1DD630C2AF27`.
- Local installer report: clean install, fully initialized launch, seeded settings/index/key/temp state, complete uninstall, and retained application data/source document all passed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- TypeScript/Vitest/.NET/Playwright: passed; 259/259, 29/29, and 5/5 respectively.
- M4/M6/M7: 50/50 retrieval; zero-dispatch budget preflight; 50/50 grounding.
- Packaged runtime: Electron 43.1.0, SQLite 3.53.1 with FTS5, helper protocol v2 with nine required features.
- Windows CI must still prove previous-main upgrade, packaged delete-all, persistence, uninstall, and artifact upload before publication is complete.
