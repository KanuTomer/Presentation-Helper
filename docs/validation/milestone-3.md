# Milestone 3 exit report

Status: **ACCEPTED — all Milestone 3 automated and live model gates passed on 2026-07-13.**

## Current prompt compatibility note

The accepted live report below remains immutable historical evidence for the `m3-final-v3` repair lineage and the mode-specific Luna/Terra request policy. PresenterAI `0.2.0-beta.4` adds spoken-delivery guidance without changing the provider schema, grounding rules, category precedence, field word ranges, models, output-token limits, `store:false`, or one-request behavior.

- Current revision: `presenter-natural-delivery-v1`.
- Instructions-and-schema SHA-256: `cb69745f89c00f4e5db1bb3cac4c682cb68ec9435ff18293e4cdd54a16668d33`.
- Added behavior: directly speakable `SAY`, calm conversational wording, evidence-bound first-person claims, compact memory cues, and a respectful spoken challenge continuation.
- Explicit exclusions: canned openings, question restatement, AI/meta wording, corporate filler, and repeated ideas across fields.
- Validation state: offline prompt/schema/grounding regressions are green; no OpenAI request was made for this revision.
- Future live report: ignored `artifacts/m3/m3-natural-delivery-live-report.json`; the evaluator deliberately does not resume the accepted historical report under different instructions.

The historical 40/40 Luna and 8/8 Terra results must not be represented as a live evaluation of the new prompt fingerprint. A separately authorized, budget-bounded live revalidation is required before making that narrower claim. This compatibility note does not reopen or erase the completed historical gate.

Latest attempt: **2026-07-13.** The Terra output-budget repair preserved all 40 passing Luna results and three passing Terra results, then reran only `g01`, `g03`, `c01`, `c03`, and `x01` in Strong mode. All five succeeded. Luna passes schema validity 40/40, category accuracy 40/40, unsupported warnings 20/20, zero inventions, and visible-word compliance 40/40. Terra passes structured output and no-invention checks 8/8.

Lifetime evaluation usage is 38,162 input tokens and 17,909 output tokens, including 1,407 recorded reasoning tokens in the final repair. Estimated lifetime cost is **$0.206648**. The immutable **$0.40** ceiling leaves **$0.193352** unused; the final repair itself cost approximately **$0.045423** against its $0.105 sub-cap. Relative to the user's added $5, the estimated untouched balance is **$4.793352**; the OpenAI billing dashboard remains authoritative.

No prompts, responses, or credentials were persisted. The ignored redacted report is at `artifacts/m3/m3-live-report.json` and contains only case IDs, model IDs, token counts, latency, cost estimates, outcome flags, and aggregate gates.

Automated mocked validation is part of `npm test`. The live gate is deliberately local and never runs in GitHub Actions:

```powershell
$env:OPENAI_API_KEY = "your key"
npm run eval:m3:live
Remove-Item Env:OPENAI_API_KEY
```

The current command uses an empty retrieval provider. It runs 40 synthetic Luna cases first and starts the eight Terra smoke cases only if all Luna gates pass. Evaluation SDK retries are disabled. Before the first request it prices the run conservatively using the serialized instructions, input, schema, and mode-specific output allowance: 450 tokens for Luna and 1,200 for Terra. It writes only redacted metrics to ignored `artifacts/m3/m3-natural-delivery-live-report.json` and does not persist prompts, responses, or the API key. Resume requires the exact prompt revision and fingerprint; the accepted historical failed-case repair list is disabled for this new lineage.

## Exit checklist

- [x] Luna structured responses: 40/40.
- [x] Category accuracy: at least 36/40 (actual 40/40).
- [x] Unsupported project warnings: at least 19/20 (actual 20/20).
- [x] Invented project numbers or results: zero accepted cases.
- [x] Visible-word target: at least 36/40 between 120 and 220 words (actual 40/40).
- [x] Terra structured/no-invention smoke gate: 8/8.
- [x] Human failed-case review: not applicable because the accepted report has no failed case IDs.
- [x] No unresolved security, fabrication, cancellation, or schema defect remains.

## 2026-07-13 initial run record

- Requested/returned model for the successful preflight: `gpt-5.6-luna` / `gpt-5.6-luna`.
- Completed Luna cases: 2 attempted, 1 valid, then fail-fast quota stop on `g02`.
- Terra cases: 0; skipped because Luna could not complete.
- Recorded estimated spend: $0.001654 of the $0.40 cap.
- Human failure review: pending; the incomplete infrastructure-blocked gate cannot be signed off.
- Milestone decision: **not accepted; Milestone 4 formal validation remains frozen.**

## 2026-07-13 resumed run record

- Luna structured responses: 40/40.
- Category accuracy: 35/40. Misclassified IDs: `u03`, `u06`, `u13`, `c04`, `x03`.
- Unsupported-project warnings: 20/20.
- Invented project numbers or results: zero detected cases.
- Visible-word target: 18/40 within 120–220 words; all misses were below 120 words.
- Terra cases: 0; skipped because the Luna category and word-count gates failed.
- Recorded lifetime estimated spend: $0.056921 of the $0.40 cap.
- Human failure review: pending for the five category mismatches and 22 short-response cases listed in the redacted report.
- Milestone decision: **not accepted; no automatic rerun is authorized and Milestone 4 formal validation remains frozen.**

## Non-billable verification after the final repair

- TypeScript typecheck: passed.
- Vitest: 50/50 tests passed across eleven files.
- .NET helper tests: 7/7 passed.
- Production Electron build: passed.
- npm audit: zero vulnerabilities.
- WASAPI helper smoke test: passed; two output devices enumerated and a 16 kHz mono WAV captured.
- Unsigned NSIS packaging: passed; `PresenterAI-0.1.0-setup.exe` generated locally.
- Repository diff whitespace check: passed.

The helper is still self-contained but is published as the standard apphost plus runtime files instead of a single 154 MB executable. This avoids a Windows `spawn UNKNOWN` failure observed when Node launched the single-file apphost; the packaged app continues to include the complete helper runtime through `extraResources`.

## 2026-07-13 targeted repair record

- Repair selection: 23 unique Luna failures rerun; 17 passing Luna results preserved.
- Luna structured responses: 40/40.
- Category accuracy: 39/40; `g02` returned `CLARIFICATION` instead of an accepted category, but the aggregate category gate passed.
- Unsupported-project warnings: 20/20.
- Invented project numbers or results: zero detected cases.
- Visible-word target: 35/40. Short IDs: `g02` (117), `u08` (113), `u18` (117), `u19` (113), and `u20` (112).
- Terra cases: 0; skipped because the Luna word-count gate missed by one qualifying response.
- Recorded lifetime estimated spend: $0.095524 of the $0.40 cap.
- Prompt lineage: preserved results are tagged `m3-baseline-v1`; repaired results are tagged `m3-repair-v2` with a SHA-256 prompt fingerprint.
- Human failure review: pending for the five short responses; no raw responses were persisted.
- Milestone decision: **not accepted; no additional rerun, Terra gate, or M4 work is authorized by this repair plan.**

## 2026-07-13 final repair and Terra record

- Repair selection: exactly five reviewed Luna failures rerun; 35 passing Luna results preserved.
- Luna structured responses: 40/40.
- Category accuracy: 40/40.
- Unsupported-project warnings: 20/20.
- Invented project numbers or results: zero detected cases.
- Visible-word target: 40/40.
- Terra cases: 3/8 valid. `g01`, `g03`, `c01`, `c03`, and `x01` each consumed exactly the 450-token cap and yielded no validated structured response.
- Recorded lifetime estimated spend: $0.161225 of the $0.40 cap.
- Report lineage: the schema-v4 report retains the earlier 23-case repair entry and appends the five-case `m3-final-v3` entry.
- Human failure review: pending for the five truncated Terra cases; no raw responses were persisted.
- Milestone decision: **not accepted; Milestone 4 remains frozen and no further paid rerun is authorized by this plan.**

## 2026-07-13 Terra output-budget acceptance record

- Repair selection: exactly five failed Terra cases rerun; 40 Luna and three Terra successes preserved.
- Requested/returned models: `gpt-5.6-luna` / `gpt-5.6-luna` and `gpt-5.6-terra` / `gpt-5.6-terra`.
- Luna: 40/40 valid schemas, 40/40 accepted categories, 20/20 unsupported warnings, 40/40 visible-word compliance, and zero inventions.
- Terra: 8/8 valid schemas, 8/8 visible-word compliance, and zero inventions.
- Terra request policy: reasoning `low`, text verbosity `low`, and 1,200 total output tokens; visible output remains constrained to 121–199 words by the strict schema.
- Final repair usage: 2,935 input tokens and 2,539 output tokens, including 1,407 reasoning tokens.
- Final repair estimated cost: $0.045423; lifetime estimated cost: $0.206648 of the $0.40 cap.
- Report lineage: schema v5 appends request revision `m3-mode-specific-output-v1` and its SHA-256 fingerprint without replacing earlier repair history.
- Human failed-case review: not applicable; `failedCaseIds` is empty.
- Milestone decision: **accepted; formal Milestone 4 implementation and offline validation may begin under a separate plan.**

Record the run date, returned model IDs, aggregate gates, reviewer name, and sign-off here. Do not paste raw model responses or API credentials into this document.
