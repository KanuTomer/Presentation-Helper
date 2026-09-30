# Beta.6 — quiet-glass audit repairs

Status: source repairs and offline UI coverage complete; **visual sign-off pending user desktop checks**. No milestone's outstanding live/audio/capture gates are accepted by this delivery.

## Evidence and changes

Original audit: `C:\Users\kanut\Downloads\PresenterAI-Audit\2026-09-30_15-26-22`.

Replacement evidence: `C:\Users\kanut\Downloads\PresenterAI-Audit\2026-09-30_11-39-19-771Z_quiet-glass` (UTC timestamp). Its report, observations, and 104 screenshots are renderer-only synthetic fixtures, not desktop-composited captures or provider results. Forced-colors and reduced-transparency screenshots are simulated media settings, not OS verification.

| Finding | Repair / evidence |
|---|---|
| READ-001, READ-002 | Stable 94% dark reading panels, 97% composer/response/code surfaces, protected headings/navigation/status/search text, stronger controls and secondary text. Four background classes plus a checkerboard at both target sizes; intensity 0/.65/1. |
| VIS-001 | Removed WebGL resources and flowing/blended lighting. Static blue-violet rim, persisted `neonIntensity`; label is now Accent intensity. |
| NAV-001 | Fresh Electron registration status, idle Retry shortcuts, existing rollback, fail-closed recovery recheck. One-profile Electron test reports all three registrations and rejects a second instance. This does not identify another application's shortcut ownership. |
| SNAP-001 | Keyless monitor selection/capture/Retake/Discard/Escape. Send remains disabled without a key; the main-process check remains authoritative. Stale captures cannot enter a new session. |
| CORNER-001 | Transparent native configuration retained without Acrylic or `setShape`. Static rendering removes shader resume dependencies. Native desktop corner sign-off remains pending. |
| Additional fixture finding | Multi-monitor selector overflow at 680px fixed with compact wrapping; explicit overflow assertion added. |

`npm run audit:ui` builds the production renderer with an isolated fixture bridge and captures a new evidence directory. It has no Electron/main-process imports, credential access, global shortcut registration, or provider client. External page requests are blocked and reported. The harness uses headless installed Chrome by default; `PRESENTERAI_AUDIT_BROWSER` can select another installed Playwright channel.

The React review checklist informed async preview revision guards, focus restoration, and retry error handling. No additional runtime dependency was added.

## Automated validation

- Final Vitest run: 404/404 passed. Source verify also passed 33/33 .NET tests, typecheck and production build.
- Electron UI: 11/11 passed, including real registration/retry, same-profile second instance, scrolling, independent code scrolling, compact responsive controls, ten hide/show cycles, and tray/emergency recovery.
- M4: 50/50 retrieval recall. M7: 50/50 offline invariants. M6 preflight: zero network requests; strict live campaign remains unauthorised/infeasible within its prior cap.
- Synthetic UI audit: 104 screenshots, no failed fixture checks or external network attempts. Includes responses, multiple schema-bounded code files, equations/matrix, warnings/citations/clarification, document import/search/inspection/pagination, usage/Unpriced, keyless snapshot, processing/errors, transcript conflict, transmission preview, shortcut confirmation, and simulated accessibility fallbacks.
- Controlled composited-token measurements: secondary text minimum 9.81:1, focus minimum 8.45:1, essential border minimum 3.63:1. These are known-token samples, not blanket WCAG certification or native desktop measurements.
- Helper smoke: two capture cycles and terminal cleanup passed. Packaged FTS5 and protocol-v2 helper health passed.
- Beta.6 NSIS/checksums built; beta.5→beta.6 lifecycle passed clean install, launch, upgrade, data preservation, Delete All/source preservation, and uninstall. Final rebuilt-package results are recorded in `artifacts/beta6-*`.
- Read-only local integrity diagnostics: Smart App Control **off**, helper **NotSigned**, spawn **ready**. No Windows policy was modified. Past SAC failures remain historical evidence, not erased.
- Diff, changed-source credential-pattern, and generated-artifact scans passed. Existing beta.5 changes and `docs/assets/` remain unstaged/uncommitted.

## Open gates

### Dependency-security follow-up (PR #8, 2026-09-30)

The historical audit failure below was repaired by pinning Electron to 43.7.7 and PDF.js to 6.3.289, and refreshing compatible transitive dependencies (including Vitest 4.1.11). npm 10.9.8 crashed in its Arborist peer resolver; temporary npm 11 completed the ordinary audit fix without `--force`, overrides, or a global npm change. Clean `npm ci` and `npm audit --audit-level=high` now report zero vulnerabilities.

Revalidation passed 42 targeted parser/retrieval/settings tests, all 404 Vitest tests, 33 .NET tests, typecheck/build, 11 Electron tests, M4/M7 50-case offline evaluations, and the non-network M6 preflight. The user confirmed the prior beta.6 visual repairs; the dependency-rebuilt Electron binary still requires physical visual confirmation before merging. Native/audio/live acceptance status is unchanged.

The rebuilt helper passed two captures; packaged Electron 43.7.7 passed SQLite 3.53.4/FTS5 and protocol-v2 helper health. NSIS packaging and beta.5-to-current lifecycle passed. The first upgrade attempt failed baseline process cleanup; no controlled processes remained afterward, and one controlled rerun passed every lifecycle assertion without changing or weakening the harness. Both local logs remain in ignored `artifacts/dependency-repair-*`. The rebuilt installer SHA256 is `f0d0875f123c55ec1a566e9e4cce5f66cd0dca698b3529d667850892d88790e2`.

`npm audit --audit-level=high` fails: 14 advisories (10 high, 4 moderate) in the existing dependency tree on 2026-09-30. Dependency updates were not authorised in this repair scope. A focused dependency-security repair is required before declaring the complete gate green.

User-assisted native checks are still required:

1. Run beta.6 over solid light/dark, dense light/dark text, and checkerboard desktop backgrounds. Check answer readability and smooth outer corners.
2. Compare initial display and the tenth shortcut/tray hide/show cycle; confirm unchanged passthrough and recovery.
3. Check 1100×720 and 680×420 at practical Windows scaling levels, including **175%**. The automated effective zoom checks are not Windows DPI evidence.
4. Enable click-through only after reading the confirmation; verify Ctrl+Shift+I and Tray → Show PresenterAI restore interaction.
5. Recheck shortcut conflicts with only one installed/development copy running. The fixture bridge never registers shortcuts.

Any unreadable answer, corner artifact, lost passthrough, scrolling failure, or recovery failure blocks visual sign-off. Audio quality, Meet/OBS compatibility, physical-device acceptance, and live model quality remain outside these offline repairs.

No API key was accessed, no paid request ran, and no commit/push/merge occurred.
