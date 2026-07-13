# Milestone 4 offline validation report

Status: **ACCEPTED — document ingestion, local FTS retrieval, Windows packaging, and the packaged FTS5 gate passed on 2026-07-14.**

PresenterAI now parses PPTX, PDF, Markdown, and UTF-8 text from immutable byte snapshots, stores the resulting deterministic chunks in a schema-versioned local SQLite catalog, and retrieves at most five whole evidence chunks within an exact 12,000-character request budget. The evaluator makes no network or OpenAI request.

## Retrieval evaluation

- Corpus: `m4-retrieval-v1`.
- Required recall: at least 43 of 50 answer-bearing chunks in the top five.
- Actual recall: **50/50 (100%)**.
- Top-one results: **50/50**.
- Failed case IDs: none.
- PPTX: 15/15.
- PDF: 15/15.
- Markdown: 10/10.
- Text: 10/10.
- Embeddings: disabled.
- External requests and API spend: none.

The committed corpus is `tests/fixtures/m4-retrieval-corpus.json`. Each run writes only aggregate metrics and failed case IDs to the ignored `artifacts/m4/m4-retrieval-report.json`; the Windows workflow uploads that redacted report with the installer artifact.

The 50-case evaluator deliberately injects deterministic pre-parsed chunks so it measures FTS query/ranking behavior in isolation. It does not claim that those 50 questions are end-to-end parser cases; real generated PPTX, PDF, Markdown, and text inputs are covered separately by the parser fixture suite below.

## Acceptance checklist

- [x] Relationship-ordered PPTX slides, relationship-resolved speaker notes, titles, repeated text, row-major tables, and excluded non-content placeholders are tested.
- [x] PDF page text, resolvable outline titles, cleanup, malformed files, encryption, genuine password protection, and image-only/empty files are tested.
- [x] Markdown ATX/Setext breadcrumbs outside fenced blocks, strict UTF-8 text, Unicode, deterministic 2,200-character splitting, and whole-word overlap are tested.
- [x] All public parser failures use the six approved document error codes and produce actionable messages.
- [x] SQLite schema-v2 creation/migration, canonical path identity, unchanged no-op, stable-ID replacement, rollback, duplicate-content paths, partial batches, restart reconciliation, and orphan-free deletion are tested.
- [x] NFKC-safe FTS queries, title/filename/location boosts, deterministic ordering, exact-text deduplication, hard top-five retrieval, and whole-chunk context budgeting are tested.
- [x] Search and 50-chunk inspection IPC are validated; renderer import outcomes, search, inspection, and evidence-support badges are tested.
- [x] Forged or duplicate model citation IDs are rejected; valid citation metadata is canonicalized from the selected chunks.
- [x] Packaged Electron reports working SQLite FTS5 through the production executable smoke path on `windows-latest`.

## Final local gate

- TypeScript typecheck: passed.
- Vitest: **99/99** tests passed across 16 files.
- .NET helper: **7/7** tests passed.
- npm audit at high severity: zero vulnerabilities.
- Offline retrieval evaluation: **50/50**.
- Production Electron build: passed.
- WASAPI helper smoke: passed with a finalized 16 kHz mono PCM WAV.
- Unsigned NSIS packaging: passed locally. A pinned `app-builder-lib` patch uses its bundled static uninstaller extractor on Windows instead of executing electron-builder's unsigned intermediate; this preserves the stock NSIS installer while respecting enforced Smart App Control.
- Packaged Electron FTS5 smoke: passed on the clean Windows runner.
- Diff, credential, generated-artifact, and redaction scans: passed before publication.

Windows CI run [29276834012](https://github.com/KanuTomer/Presentation-Helper/actions/runs/29276834012) reproduced dependency restore, audit, typecheck, 99 Vitest cases, seven .NET tests, helper publishing, Electron build, 50/50 retrieval evaluation, NSIS packaging, packaged FTS5 verification, and artifact upload. The `PresenterAI-Windows-beta` artifact contains the installer and redacted retrieval report. The project did not disable Smart App Control or introduce code signing.

## Remaining project-wide validation

This report accepts Milestone 4 only. It does not claim that the outstanding Meet/OBS capture matrix, multi-monitor/fullscreen checks, or physical audio-device matrix from earlier milestones has been completed. OCR, vision, embeddings, process-specific Chrome capture, continuous listening, code signing, and a public release remain excluded.
