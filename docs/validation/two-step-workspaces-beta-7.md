# Two-step workspaces — beta.7

Date: 2026-10-18. Source implementation and scoped automated validation complete; not a formal beta/release acceptance.

## Behavior

- Startup is Setup: normal taskbar visibility, not topmost, no restored listening or click-through. Existing configuration, documents, usage, privacy, diagnostics and retention controls remain available in grouped sections.
- A single native window switches modes. Entering hides Setup, requests content protection, verifies Electron's report, commits the presenter renderer, then shows it topmost. Failure stays in Setup; a missing renderer acknowledgement leaves the window hidden for tray retry.
- Returning through header, tray Settings or privacy/error routes requires a confirmation inside the protected renderer. Active operations require explicit cancellation and completed cleanup before Setup can become visible. Setup is unprotected only after its renderer commits while hidden.
- Presenter height follows natural content, capped to the monitor work area. One Fold/Show control retains the answer. Width/position and Setup bounds persist independently; generated heights do not. Schema v6 migrates to v7 without changing models, consent, recorded usage or documents. Secret storage is unchanged.
- Capture/transmission consent, snapshot preview, code/math rendering, grounding and USD usage policies are unchanged. Capture exclusion remains path-dependent, not universal invisibility.

## Automated evidence

- Typecheck and production build passed.
- Final Vitest: **413/413**, 59 files. .NET: **33/33**.
- Electron: **14/14**, including normal startup, protection transition, measured growth/shrink, scrolling, effective zoom/layout, two capture cycles, cancellation-before-return, retained composer, ten hide/show cycles, real shortcut recovery, tray confirmation, conflicts/rollback and security preferences.
- M4 **50/50**, M7 **50/50**; M6 preflight used **zero network requests**.
- NSIS beta.7 built; packaged Electron 43.7.7 passed SQLite 3.53.4/FTS5 and protocol-v2 helper health.
- Beta.6 → beta.7 installer lifecycle passed clean install, launch, upgrade, data preservation, Delete All/source preservation and uninstall.
- The initial layout installer passed lifecycle validation before the snapshot-only follow-up below. Its SHA256 was `82498ba8b523fe9af3a5b204829b12bd45814f5fd1c28f3763fb805959ca9f32`.
- Initial native tests failed while an installed copy held the global shortcuts. After that copy exited, the clean final suite passed. The scroll fixture was moved into measured content, and recovery assertions now wait for pending content-size changes to settle; assertions were not removed.
- Detailed local logs are ignored `artifacts/beta7-*`; installer diagnostics are in `artifacts/installer/`.

## Snapshot schema follow-up

- A user-authorized GPT-6 Luna diagnostic using a generated arithmetic PNG reproduced HTTP 400 `invalid_json_schema`: the provider rejected the generated Unicode-property language regex.
- Replacing only that pattern in memory completed successfully and produced a locally validated math solution. Returned usage was 646 input tokens and 225 output tokens (including 42 reasoning tokens), estimated at USD 0.0001771. No desktop content was sent; credentials, images, prompts, answers and reasoning content were not persisted.
- Production snapshot output now uses the same bounded ASCII language identifiers as developer output. Schema rejection gets an actionable, non-retryable message without exposing provider payloads. Regression tests failed before the fix and passed afterward.
- Final pre-push Vitest: **415/415**, 59 files; targeted snapshot/AI suite: **56/56**. Typecheck, production build, helper publishing, NSIS packaging, packaged FTS5 and helper health passed. No additional paid request was made while applying or packaging the fix.
- Rebuilt beta.7 installer SHA256: `88807607647ec012754501fd538bbb6b418c2ae73dc82f9e54dbb3d3dcf47280`. The packaged main bundle was verified against the built bundle. The full installer lifecycle was not repeated for this schema-only follow-up.

## Open gates

The fresh dependency audit reports **11 advisories: 2 high, 8 moderate, 1 low**. High findings are `http-cache-semantics` and `source-map-js`; KaTeX's recommended fix is a breaking 0.19.0 upgrade. No dependency upgrades or audit suppressions are included in this layout change. This blocks a fully green release gate.

Manual desktop checks are pending: native DPI (including 175%), contrasting desktop backgrounds, smooth native corners, practical resize/recovery, and each named capture-protection compatibility path. Automated effective zoom and renderer corner samples do not substitute for these checks. Existing M0–M2 and M5–M8 manual/live acceptance remains unchanged.

The workspace implementation used no Computer Use, API-key access, paid evaluation, or signing purchase. Unrelated social-card files remain untouched. No merge is included in the subsequent GitHub delivery.
