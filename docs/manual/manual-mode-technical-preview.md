# Closed manual-mode technical preview

This guide is for the project owner or a small number of trusted Windows 11 x64 testers. Use it only after the installer-repair PR and its post-merge `main` Windows workflow are green.

The preview covers typed questions, local document ingestion and retrieval, grounding, settings, privacy, upgrade, and removal. It does **not** validate audio capture, Google Meet behavior, capture exclusion, or readiness for a general personal beta. Listening must remain OFF throughout this preview.

## Obtain and verify the build

1. Open the repository's **Actions** page and select the newest successful Windows Beta run whose branch is `main`.
2. Confirm the workflow commit is the current remote `main` commit and that the complete installer lifecycle step passed.
3. Download and extract the `PresenterAI-Windows-beta` artifact. Do not use artifacts from PR #3 or either failed `986469b` workflow.
4. Confirm the artifact contains the unsigned `PresenterAI-0.2.0-beta.4-setup.exe`, `SHA256SUMS.txt`, and redacted validation/lifecycle reports.
5. In PowerShell, calculate the installer hash:

   ```powershell
   Get-FileHash ".\PresenterAI-0.2.0-beta.4-setup.exe" -Algorithm SHA256
   ```

6. Compare the complete hexadecimal value with the matching entry in `SHA256SUMS.txt`. Stop if the filename or hash differs.

Use a disposable Windows account or VM where practical. The installer is unsigned. If SmartScreen presents its normal reviewed override, proceed only after confirming the repository, workflow, commit, and hash. If Smart App Control blocks the installer or application, stop and report the block; do not disable or bypass Windows security.

## Safe first run

1. Install per-user without requesting administrator privileges.
2. Start PresenterAI and confirm listening is OFF.
3. Confirm the tray menu can show the overlay and quit the application completely.
4. Test the fixed `Ctrl+Shift+I` recovery shortcut before enabling click-through.
5. Verify Ask and Hide/Show shortcuts while another application has focus.
6. Restart PresenterAI and confirm bounds, neon intensity, and non-audio preferences are restored.
7. Treat capture status only as requested, Electron-reported, or manually recorded. Do not infer that the overlay is absent from any recording or sharing path.

Do not enable listening, accept listening consent, or run a Meet/OBS/capture-protection experiment in this preview. System loopback can include every sound on the selected output endpoint, and its physical/live gate is still incomplete.

## Typed and document checks

Use synthetic, non-sensitive PPTX, PDF, Markdown, and strict UTF-8 text files. Image-only or scanned documents, encrypted/password-protected files, charts without extractable text, and vision-dependent content are unsupported.

For billable typed-answer checks, create a dedicated OpenAI project/key with a small hard limit—preferably no more than USD 0.10—and use Normal/Luna. Never include the key in screenshots, recordings, issue text, or attached logs.

| Case | Action | Expected result |
|---|---|---|
| General explanation | Ask a general technical question with no project fact. | Support is `general-technical`; no document citation is invented. |
| Exact project fact | Ask for a fact stated plainly in one fixture. | Support is `document-supported`; displayed citation matches the correct file and page/slide/section. |
| Mild paraphrase | Ask the same fact with different wording but a lexical anchor. | An answer-bearing chunk is retrieved within the bounded top five. |
| Unsupported result | Ask for an absent accuracy, runtime, dataset, experiment, or performance number. | A visible evidence warning/refusal appears; no result is invented. |
| Challenge | Ask a skeptical objection to a supported statement. | Response acknowledges the challenge, uses supplied evidence, and states a limitation. |
| Follow-up | Ask a supported question, then “How does that compare?” | Only the immediate prior reviewer question helps resolve the reference; the previous answer is not treated as evidence. |
| Contradiction | Import two fixtures that disagree and ask for the disputed fact. | The response explicitly reports conflicting evidence and cites supplied chunks. |
| Session clearing | Clear the session, then repeat a referential follow-up. | Cleared conversation context does not reappear through a late operation. |
| Document removal | Remove an indexed fixture, then search for its unique term. | Search and future answer context omit it; the original source file remains untouched. |
| Cancellation | Start a typed operation and press `Esc`. | UI returns cleanly to idle; no late answer or stale context update appears. |

Before a response request, inspect the outbound preview. It must show only the selected chunks and bounded background categories. The application must not show the stored API key, an entire source document, or unrelated chunks.

## Settings, retention, upgrade, and removal

Use disposable fixture data for destructive tests.

1. Test clear-session, clear-usage, clear-compatibility, clear-documents/index, and API-key deletion independently.
2. Confirm each operation affects only its named PresenterAI scope.
3. Enter the exact `DELETE ALL` confirmation while the app is idle. Confirm PresenterAI settings, index, context, usage, compatibility records, consent, encrypted key state, and owned temporary files are cleared.
4. Confirm every original PPTX/PDF/Markdown/text source file still exists and is unchanged.
5. Uninstall PresenterAI. Confirm application binaries and shortcuts are removed while application data remains unless Delete All was run.

For an independent upgrade check:

1. Verify and install the previous successful `main` installer in the same controlled account.
2. Add disposable settings and fixture documents, then quit from the tray.
3. Install the verified `0.2.0-beta.4` artifact over it.
4. Confirm settings and indexed catalog remain usable, the helper health is reported, and source files are unchanged.
5. Perform Delete All and final uninstall as described above.

## Report a result

Record only:

- case ID and date;
- workflow URL, Git commit, installer filename, and SHA-256;
- Windows edition/build, GPU/driver, and monitor layout/scaling;
- exact steps, expected result, actual result, and repeatability;
- a screenshot with keys and source content redacted, when useful.

Do not retain or attach API keys, proprietary document text, raw prompts/answers, audio, transcripts, or temporary WAV files.

Stop testing and report immediately if:

- an API key appears outside its password-entry control or in logs/output;
- audio starts without explicit consent, continues after cancellation, or leaves a temporary WAV;
- a response invents project-specific evidence or accepts a forged/duplicate citation;
- upgrade, Delete All, or uninstall removes or modifies a source document;
- the app crashes, loses indexed data unexpectedly, or cannot be recovered through the tray or `Ctrl+Shift+I`;
- the installer hash differs, Windows security blocks the build, or the selected Actions run is not green.

Use `docs/manual/windows-beta-validation.md` later for the owner-assisted physical-device, Meet, and capture matrices. Passing this technical preview does not satisfy those acceptance gates.
