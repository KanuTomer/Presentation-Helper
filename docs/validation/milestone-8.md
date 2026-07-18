# Milestone 8 secure settings, privacy, and cost-control record

Status: **SOURCE COMPLETE / OFFLINE GREEN; REPAIR-PR CROSS-VERSION LIFECYCLE GREEN — formal acceptance remains dependent on Milestones 2–7 and a green post-merge `main` lifecycle.**

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

The local machine did not provide a previous successful `main` installer baseline during the 2026-07-16 branch gate. GitHub Actions later supplied the exact previous successful `main` installer, exposing a backward-compatibility defect in the harness: it launched the old build with the newly added `--presenter-installer-launch-smoke` result-file hook. The old application did not implement that hook, remained a normal tray application, and never wrote the expected result. The workflow timed out before the upgraded application, packaged Delete All, post-delete persistence, second uninstall, or artifact upload ran.

PR [#3](https://github.com/KanuTomer/Presentation-Helper/pull/3) nevertheless merged at commit `986469b`; its [PR workflow](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29513275263) and the [post-merge `main` workflow](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29513301865) recorded the same harness failure. This does not prove a current-application launch defect, but it also supplies no evidence for any skipped later lifecycle assertion. The approved repair must initialize the legacy baseline through artifacts the legacy build actually supports, verify controlled shutdown, then retain the strict result-file hook for current clean and post-upgrade launches.

| Gate | Result |
|---|---|
| TypeScript and full Vitest suite | Repair branch passed; 41 files, 284/284 tests |
| M3 and M4 regression suites | Passed; M4 top-five recall 50/50 |
| M6 offline budget preflight | Passed without network dispatch; campaign remains correctly infeasible under the immutable cap |
| M7 50-case offline evaluator | Passed 50/50 with zero failed IDs |
| .NET helper tests and WASAPI smoke | 29/29; protocol v2, two devices, valid 16 kHz mono WAV |
| Playwright Electron suite | Passed 5/5 |
| Historical production Electron/NSIS packaging | Passed with Electron 43.1.0 and upstream electron-builder 26.15.3 |
| Repair-branch local NSIS packaging | Blocked by Windows Smart App Control rejecting electron-builder's unsigned intermediate with `spawn UNKNOWN`; security controls were not disabled or bypassed. Clean Windows CI remains mandatory. |
| Packaged FTS5/helper probes | SQLite 3.53.1 FTS5 passed; helper protocol v2 with nine required features passed |
| Installer clean launch/uninstall probe | Passed; full initialization, seeded-data preservation, complete payload removal |
| PR #3 and post-merge installer lifecycle | Failed before upgrade validation; legacy build did not support the new result-file hook |
| [Repair PR #4 first lifecycle run](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29640718999) | Passed clean install, legacy initialization, genuine upgrade, current launch, and data preservation; then exposed a deterministic temporary-audio Delete All self-lock. The maintenance-authorized cleanup fix and regression are included in the updated repair commit. |
| [Repair PR #4 second lifecycle run](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29641353891) | Passed clean install/uninstall, legacy initialization, genuine upgrade, current launch, data preservation, all eight Delete All scopes, and source-document preservation. It then exposed a test-harness TOCTOU: recursive payload enumeration received `ENOENT` while NSIS was deleting a traversed directory, aborted after about three seconds instead of polling for 60 seconds, and reported the transient alphabetic tail as leftovers. The repair now ignores only vanished-path `ENOENT`, propagates other filesystem errors, and retains the strict real-deadline assertion. |
| [Repaired previous-main upgrade/delete-all/uninstall probe](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642064032) | Passed clean current install/uninstall, exact `e24e20d` baseline initialization, genuine upgrade, settings/index/consent/usage/key-state preservation, current packaged launch, all eight Delete All scopes, source preservation, final uninstall, and empty payload. |
| Credential/generated-artifact/redaction scans | Passed before the focused commit; generated installers, helper output, raw responses/transcripts, and credentials remain untracked. |

## Formal acceptance blockers

Milestone 8 depends on Milestones 2–7 in the original plan. The capture-protection matrix, physical-device/manual M5 campaign, budget-blocked M6 live campaign, and separately authorized M7 live model evaluation remain incomplete. Consequently this record may say **source complete/offline green** after the branch gate, but must not say that the personal beta or Milestone 8 is formally accepted.

## Evidence and repair record

- Local gate date: 2026-07-16; M7/M8 source merge: `986469b` through PR #3.
- Historical local installer: `PresenterAI-0.1.0-setup.exe`, SHA-256 `86F089B077221C38FB37C7739882D4C9854A72E91FA85D76FD3B1DD630C2AF27`. This is local clean-lifecycle evidence, not an independently testable accepted-beta artifact.
- Local installer report: clean install, fully initialized launch, seeded settings/index/key/temp state, complete uninstall, and retained application data/source document all passed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- Repair-branch TypeScript/Vitest/.NET/Playwright: passed; 284/284, 29/29, and 5/5 respectively.
- M4/M6/M7: 50/50 retrieval; zero-dispatch budget preflight; 50/50 grounding.
- Packaged runtime: Electron 43.1.0, SQLite 3.53.1 with FTS5, helper protocol v2 with nine required features.
- PR #3 merged as `986469b`; its PR workflow and post-merge `main` workflow failed at the legacy-baseline launch step before upgrade assertions.
- Repair target: `PresenterAI-0.2.0-beta.1` with a legacy-compatible baseline probe, strict current-build hooks, redacted lifecycle diagnostics, and a SHA-256 manifest.
- Repair branch offline/source gate: audit, 284/284 Vitest, 29/29 .NET, M4 50/50, M7 50/50, M6 zero-network preflight, helper smoke, and 5/5 Playwright passed on 2026-07-18. A fresh local NSIS retry again stalled at the unsigned `makensis` stage under Smart App Control and was terminated without disabling or bypassing Windows security. The incomplete installer could not support fallback packaged probes, so the complete local installer gate is not passed; clean Windows CI remains authoritative.
- Repair PR Windows workflow: **Passed** in [run 29642064032](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642064032). Lifecycle report `ok=true`; clean and upgraded uninstalls each reached zero payload. The installer SHA-256 is `3995A2DE9AD478A1C3EEE7CC62B82AACE27B75E4AC9F5FA5ACE5BC879A9D24E6`, matching the uploaded manifest.
- Post-merge `main` workflow and artifacts: **Pending — this is the publication gate for the closed manual-mode technical preview.**
