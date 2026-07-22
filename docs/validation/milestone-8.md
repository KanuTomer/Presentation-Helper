# Milestone 8 secure settings, privacy, and cost-control record

Status: **SOURCE COMPLETE / OFFLINE GREEN; CROSS-VERSION LIFECYCLE GREEN ON PR AND POST-MERGE MAIN — formal acceptance remains dependent on Milestones 2–7.**

This milestone makes repeated personal use safer and more understandable. It does not add telemetry, accounts, cloud synchronization, automatic exchange-rate lookup, code signing, auto-update, or a public release. Listening still starts OFF on every launch.

## Implemented controls

- Stored settings use a versioned, strictly validated schema with deterministic migration from the prior unversioned format. Invalid persisted fields fall back safely and produce a local recovery warning.
- Shortcut entry records the supported Windows accelerator subset. `Esc` cancels recording, modifier-only and unsupported keys are rejected, all configurable shortcuts are applied transactionally, and `Ctrl+Shift+I` remains reserved for emergency interaction recovery.
- The API-key status returned from storage exposes configuration/protection metadata only; it never returns key material or suffixes. A key newly typed by the user exists transiently in the renderer's password input, is sent through the narrow save-key IPC method, is immediately cleared from that input, and is not retained in React state, logs, snapshots, or plaintext settings. Privacy copy explains that Windows DPAPI primarily protects against other Windows users, not every process already running as the same user.
- Toggle listening requires a versioned first-use acknowledgement through every capture entry point. A missing acknowledgement opens Privacy and prevents capture rather than merely warning after capture begins.
- An operation-scoped preview is painted and acknowledged before each external transmission. The transcription preview describes the bounded audio and terminology hint; the response preview shows the exact selected evidence chunks and bounded background categories. The validated transcript enters renderer memory only as an editable draft and is never persisted.
- Preview acknowledgements use operation ID and stage. A stale acknowledgement is ignored; failure to acknowledge within two seconds fails closed before network dispatch.
- Usage is recorded as bounded per-request metadata, with exact requested/returned model IDs, endpoint, supported token fields, duration, price version, and priced/unpriced status. The newest 100 records remain inspectable and older records roll into aggregate model/endpoint totals.
- Unknown requested models are blocked by the session cap; missing usage or unpriced returned model IDs retain their complete reservation. Usage and the persistent session ledger are displayed in USD only.
- Independent controls clear conversation context, usage estimates, capture compatibility records, the local document catalog/index, and encrypted API-key ciphertext.
- Delete-all requires an idle application and exact `DELETE ALL` confirmation. Its service reports per-scope failures, resets PresenterAI settings, clears the local index/catalog and other application-owned state, removes encrypted key files and PresenterAI-owned temporary WAVs, and never targets the user's original source documents. The production deletion service is covered directly and through the restricted packaged smoke hook; the previous-main upgrade/delete-all lifecycle remains a required Windows CI assertion.

## Privacy boundary

PresenterAI sends audio only after an acknowledged toggle-listening operation. It displays the resulting transcript for editing, and sends response context only after a separate explicit submission. Responses use `store:false`; the application creates no OpenAI Conversation and stores no cloud meeting history. Bounded WAV data is deleted locally before the transcript draft is exposed.

The in-product disclosure follows OpenAI's current [data-controls documentation](https://developers.openai.com/api/docs/guides/your-data): ordinary Responses API abuse-monitoring retention can still apply, while the published endpoint table currently lists no application-state or abuse-monitoring retention for audio transcription. API content is not used for model training unless the customer opts in. These provider statements are version-sensitive and must be rechecked before each release.

## Offline verification

The committed deterministic tests and test harnesses are intended to cover:

- Legacy and corrupt settings migration, strict renderer-patch validation, and recovery warnings.
- Keyboard recording, key normalization, autorepeat, `Esc`, unsupported keys, emergency reservation, conflict rollback, and restoring all defaults in one transaction.
- Consent versioning and capture blocking from buttons, the global shortcut, and helper shortcut events.
- Preview ordering, first-frame acknowledgement, timeout, cancellation, stale operations, and proof that no upload/generation starts first.
- Per-model usage pricing, conservative pre-dispatch reservations, reasoning/audio token accounting, incomplete responses, unknown model snapshots, restart persistence, bounded history rollover, USD cap display, and clearing/New Session semantics.
- Every retention scope, partial failures, no FTS orphans, key/temp cleanup, original-source preservation, and active-operation rejection. Packaged relaunch and post-delete persistence must be proven by the final installer lifecycle gate.
- Renderer accessibility and error states for consent, shortcut recording, preview, usage, and destructive confirmation.
- Clean current install, isolated launch, previous-successful-main upgrade, settings/index preservation, uninstall binary removal, packaged delete-all, and user-data/source-document preservation. These are requirements of the installer script/workflow, not recorded passing evidence until the final Windows run succeeds.

The final local branch gate completed on 2026-07-16. Smart App Control intermittently rejected direct unsigned `win-unpacked` launches, so the packaged probes fail closed to a controlled temporary NSIS installation rather than disabling or bypassing Windows policy. The clean installer lifecycle uses the same upstream electron-builder NSIS output, waits for full application initialization and graceful cleanup, proves complete binary removal, and proves that PresenterAI data and the user's source document survive uninstall.

The local machine did not provide a previous successful `main` installer baseline during the 2026-07-16 branch gate. GitHub Actions later supplied the exact previous successful `main` installer, exposing a backward-compatibility defect in the harness: it launched the old build with the newly added `--presenter-installer-launch-smoke` result-file hook. The old application did not implement that hook, remained a normal tray application, and never wrote the expected result. The workflow timed out before the upgraded application, packaged Delete All, post-delete persistence, second uninstall, or artifact upload ran.

PR [#3](https://github.com/KanuTomer/Presentation-Helper/pull/3) nevertheless merged at commit `986469b`; its [PR workflow](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29513275263) and the [post-merge `main` workflow](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29513301865) recorded the same harness failure. This does not prove a current-application launch defect, but it also supplies no evidence for any skipped later lifecycle assertion. The approved repair must initialize the legacy baseline through artifacts the legacy build actually supports, verify controlled shutdown, then retain the strict result-file hook for current clean and post-upgrade launches.

| Gate | Result |
|---|---|
| TypeScript and full Vitest suite | Current beta.2 tree passed; 50 files, 352/352 tests |
| M3 and M4 regression suites | Passed; M4 top-five recall 50/50 |
| M6 offline budget preflight | Passed without network dispatch; campaign remains correctly infeasible under the immutable cap |
| M7 50-case offline evaluator | Passed 50/50 with zero failed IDs |
| .NET helper tests and audio smoke | 33/33; strict local WASAPI produced valid 16 kHz mono WAVs, while CI's dual-gated deterministic process smoke explicitly reports that it does not validate WASAPI |
| Playwright Electron suite | Passed 9/9, including two sequential toggle operations, every-tab scrolling at both target sizes, nested code scrolling, and the sandboxed preload boundary |
| Historical production Electron/NSIS packaging | Passed with Electron 43.1.0 and upstream electron-builder 26.15.3 |
| Beta.2 local NSIS packaging | Installer and SHA-256 manifest built successfully. Packaged FTS/helper probes passed after reputation evaluation, but enforced Smart App Control blocks the unsigned .NET test assembly and the clean-install lifecycle timed out. Security controls were not disabled or bypassed; clean Windows CI remains mandatory. |
| Packaged FTS5/helper probes | SQLite 3.53.1 FTS5 passed; helper protocol v2 with nine required features passed |
| Installer clean launch/uninstall probe | Passed; full initialization, seeded-data preservation, complete payload removal |
| PR #3 installer lifecycle | Failed before upgrade validation; legacy build did not support the new result-file hook |
| [Repair PR #4 first lifecycle run](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29640718999) | Passed clean install, legacy initialization, genuine upgrade, current launch, and data preservation; then exposed a deterministic temporary-audio Delete All self-lock. The maintenance-authorized cleanup fix and regression are included in the updated repair commit. |
| [Repair PR #4 second lifecycle run](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29641353891) | Passed clean install/uninstall, legacy initialization, genuine upgrade, current launch, data preservation, all eight Delete All scopes, and source-document preservation. It then exposed a test-harness TOCTOU: recursive payload enumeration received `ENOENT` while NSIS was deleting a traversed directory, aborted after about three seconds instead of polling for 60 seconds, and reported the transient alphabetic tail as leftovers. The repair now ignores only vanished-path `ENOENT`, propagates other filesystem errors, and retains the strict real-deadline assertion. |
| [Repaired previous-main upgrade/delete-all/uninstall probe](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642064032) | Passed clean current install/uninstall, exact `e24e20d` baseline initialization, genuine upgrade, settings/index/consent/usage/key-state preservation, current packaged launch, all eight Delete All scopes, source preservation, final uninstall, and empty payload. |
| [Post-merge `main` lifecycle](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642541009) | Passed at `dc1b609`; uploaded `PresenterAI-Windows-beta`, `SHA256SUMS.txt`, M7/M8 records, and redacted lifecycle diagnostics. |
| Credential/generated-artifact/redaction scans | Passed before the focused commit; generated installers, helper output, raw responses/transcripts, and credentials remain untracked. |

## Formal acceptance blockers

Milestone 8 depends on Milestones 2–7 in the original plan. The capture-protection matrix, physical-device/manual M5 campaign, budget-blocked M6 live campaign, and separately authorized M7 live model evaluation remain incomplete. Consequently this record may say **source complete/offline green** after the branch gate, but must not say that the personal beta or Milestone 8 is formally accepted.

## Evidence and repair record

- Local gate date: 2026-07-16; M7/M8 source merge: `986469b` through PR #3.
- Historical local installer: `PresenterAI-0.1.0-setup.exe`, SHA-256 `86F089B077221C38FB37C7739882D4C9854A72E91FA85D76FD3B1DD630C2AF27`. This is local clean-lifecycle evidence, not an independently testable accepted-beta artifact.
- Local installer report: clean install, fully initialized launch, seeded settings/index/key/temp state, complete uninstall, and retained application data/source document all passed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- Current local TypeScript/Vitest/Playwright: passed; 352/352 and 9/9 respectively. The latest isolated .NET run reached 33/33; the strict wrapper still treats any Code Integrity zero-test outcome as `blocked-by-smart-app-control`, never as a pass.
- M4/M6/M7: 50/50 retrieval; zero-dispatch budget preflight; 50/50 grounding.
- Packaged runtime: Electron 43.1.0, SQLite 3.53.1 with FTS5, helper protocol v2 with nine required features.
- PR #3 merged as `986469b`; its PR workflow and post-merge `main` workflow failed at the legacy-baseline launch step before upgrade assertions.
- Delivery target: `PresenterAI-0.2.0-beta.2`, upgrading from the `0.2.0-beta.1` baseline with strict current-build hooks, redacted lifecycle and Code Integrity diagnostics, and a SHA-256 manifest.
- Current offline/source gate: audit, 352/352 Vitest, 33/33 .NET tests in the latest isolated run, M4 50/50, M7 50/50, M6 zero-network preflight, two-cycle helper smoke, 9/9 Playwright, production build, NSIS packaging, and packaged FTS/helper probes completed on 2026-07-22. Enterprise Code Integrity has blocked unsigned local payloads, and the local clean-install lifecycle timed out; both remain fail-closed without disabling or bypassing Windows security. Clean Windows CI is authoritative for beta.2 delivery.
- Repair PR Windows workflow: **Passed** in [run 29642064032](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642064032). Lifecycle report `ok=true`; clean and upgraded uninstalls each reached zero payload. The installer SHA-256 is `3995A2DE9AD478A1C3EEE7CC62B82AACE27B75E4AC9F5FA5ACE5BC879A9D24E6`, matching the uploaded manifest.
- Post-merge `main` workflow and artifacts: **Passed** in [run 29642541009](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29642541009) for `dc1b609`. That baseline is eligible for the closed manual-mode technical preview; later source changes require a new green workflow.
