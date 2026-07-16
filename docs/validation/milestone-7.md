# Milestone 7 conversation context and grounding record

Status: **SOURCE COMPLETE / OFFLINE GREEN — formal acceptance still depends on accepted M6 evidence and a separately authorized live Luna evaluation.**

No OpenAI request, API credential, or billable evaluation is used by this branch gate.

## Implemented invariants

- Typed and audio questions use the same immutable prepared-answer path. A prepared snapshot contains the validated current question, context revision, expanded retrieval query, selected bounded chunks, five-turn background, and bounded project summary.
- Conversation memory retains five questions and locally derived answer summaries in memory only. Questions are limited to 1,000 Unicode code points, summaries to 600, and the project summary to 4,000.
- Referential retrieval may append only the immediately preceding reviewer question. It never uses a prior model answer as evidence, and the 4,000-code-point query limit reserves space for that antecedent.
- Clearing a session increments its revision. An already prepared late answer may render, but it cannot repopulate cleared context or replace the exact chunks/background already disclosed in the outbound preview.
- Project summaries and conversation summaries are labeled reference/background only. Retrieved document chunks remain the only project-specific evidence.
- Structured responses report `document-supported`, `general-technical`, or `unsupported-project-claim` plus `none`, `missing`, `insufficient`, or `conflicting` evidence status.
- Document-supported answers require unique citations from the exact selected chunks. General explanations cannot carry citations or project-warning state. Unsupported project claims require an explicit warning and evidence issue.
- Contradictory project evidence requires two supplied citations, an unsupported/conflicting support state, and an explicit conflict warning. Forged and duplicate citations remain malformed output.
- One Responses request is used per answer with `store:false`; PresenterAI creates no OpenAI Conversation and uses no `previous_response_id`.

## Offline corpus and evaluator

The committed `m7-offline-v2` corpus contains exactly 50 synthetic cases:

- 20 follow-ups: 15 supported and five unsupported.
- 15 additional unsupported/adversarial project claims.
- Five supported factual questions.
- Five skeptical challenges.
- Five contradictory-source questions.

`npm run eval:m7` runs the production conversation and prepared-answer path against an in-memory production `RetrievalIndex` backed by SQLite FTS5, then applies the same schema, citation, support, and grounding validators used by production. Supported follow-up evidence is keyed to the prior reviewer question, so retrieval must actually use the antecedent. Document-supported cases carry synthetic semantic anchors so a generic answer cannot count as resolving a follow-up. Unsupported checks reject numeric and named declarative project fabrications; challenge checks require acknowledgement, evidence-based defence, and limitation language; contradiction checks reject silently choosing either supplied side.

This is an offline invariant/retrieval-orchestration evaluation, not a model-quality claim and not a replacement for the accepted M4 FTS recall corpus. The final branch result and generated redacted JSON path must be recorded only after the complete gate runs.

| Offline gate | Required | Result |
|---|---:|---:|
| Corpus cases | 50 | 50 |
| Referential follow-ups containing the prior reviewer question | 20/20 | 20/20 |
| Production SQLite FTS5 prepared selections matching bounded evidence | 50/50 | 50/50 |
| Grounding/citation invariants | 50/50 | 50/50 |
| Semantic anchor, unsupported-safety, challenge, and conflict checks | 50/50 | 50/50 |
| Failed case IDs | 0 | 0 |

## Live gate (not run)

`npm run eval:m7:live -- --budget-usd=N` is opt-in, refuses CI, requires an explicit positive budget, disables SDK retries, checks the conservative maximum before every request, and writes only redacted metrics. It does not persist prompts, model answers, reasoning content, or credentials.

Formal M7 acceptance remains blocked until M6 is accepted and the user separately authorizes a live budget. The unchanged promotion thresholds are:

- At least 18/20 follow-up resolutions.
- At least 19/20 unsupported warnings/refusals.
- Zero accepted invented project results, including named dataset/hardware/algorithm claims.
- Every citation was supplied in that request.
- Explicit neutral conflict handling for 5/5 contradiction cases.
- Structured challenge handling for 5/5 challenge cases.

Until that later gate passes, UI, documentation, commits, and release notes must say **source complete/offline green; formal acceptance pending**, never “M7 accepted.”

## Branch evidence

- Gate date: 2026-07-16; commit: the commit containing this record.
- `npm run eval:m7`: 50/50 passed, 20/20 contextual follow-ups, 50/50 production FTS selections, 50/50 semantic checks, 50/50 grounding checks, zero failed IDs.
- Redacted report: `artifacts/m7/m7-offline-report.json` (generated and ignored locally; uploaded by Windows CI).
- Regression gate: TypeScript checks passed; Vitest 259/259; .NET helper tests 29/29; Electron production build passed.
- No live M7 harness, OpenAI credential read, or OpenAI request occurred.
- Windows PR/post-merge CI and uploaded-report links are publication evidence and are recorded on GitHub rather than predeclared here.
