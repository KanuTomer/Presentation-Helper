# Clear glass, compact Copilot, and natural presenter validation

Delivery target: `0.2.0-beta.4`.

This record supersedes beta.3's Acrylic/native-shape visual experiment. It changes presentation and prompt delivery guidance only; it does not accept any outstanding M0–M2 or M5–M8 manual gate, spend API credits, enable screen capture, or claim universal capture exclusion.

## Implemented invariants

- The frameless BrowserWindow is transparent, shadowless, and requests Windows rounded corners. It does not request Acrylic and does not apply a polygonal native window shape.
- The renderer owns one consistent 24px clip. Shell tint is intentionally light, readable surfaces use fixed local opacity, and Neon intensity changes only localized blue-violet shader/CSS emission.
- Every initial show, shortcut/tray show, restore, focus-show, resize, DPI change, and display change publishes a typed `surfaceRestored` event. The WebGL layer resumes, resizes, and draws immediately.
- Reduced-transparency and forced-colors users receive an opaque accessible surface with the shader hidden. Reduced motion freezes animation, while WebGL loss uses a CSS fallback.
- Copilot uses a single compact command surface beneath a 72px composer. Presenter/Code, click-through, submit, and system-audio controls remain reachable; the bar is one row at 600 CSS pixels or wider and wraps within the same surface below that width.
- Presenter revision `presenter-natural-delivery-v1` adds directly speakable, conversational delivery guidance. Provider schema, grounding invariants, category precedence, word constraints, models, token limits, `store:false`, and one-request behavior remain unchanged.
- The historical M3 live report remains immutable. The new prompt fingerprint is offline-validated and requires separately authorized live revalidation.

## Non-billable evidence

Local gate run: 2026-07-23.

| Gate | Local result |
|---|---|
| Dependency audit | Passed; zero vulnerabilities |
| TypeScript, Vitest, production build | Passed; 380/380 tests across 54 files |
| .NET helper unit tests | Passed; 33/33 |
| M4 retrieval | Passed; 50/50 top-five recall |
| M6 preflight | Passed with zero network requests; projected estimate `$0.149573`, strict documented maximum `$0.645873`, live dispatch blocked |
| M7 offline grounding | Passed; 50/50 with no failed IDs |
| Playwright Electron | All nine non-native UI/security cases passed. The native-audio case failed explicitly at helper spawn with `UNKNOWN` after Smart App Control evaluated the rebuilt unsigned helper. |
| Packaged FTS | Passed with Electron 43.1.0, SQLite 3.53.1, and FTS5 |
| Helper/process and packaged-helper smoke | Blocked by enforced Smart App Control; helper signature `NotSigned`, spawn outcome `blocked-by-policy-or-access` |
| NSIS and beta.3-to-beta.4 lifecycle | Local NSIS uninstaller generation was blocked at `spawn UNKNOWN`; the partial installer could not produce an installed payload. Clean Windows CI is mandatory and may not convert this into a skipped pass. |
| Diff/redaction/credential scans | Required immediately before each commit and push |

The desktop-composited visual gate passed on 2026-07-23 using an isolated E2E profile with capture protection disabled only for the controlled inspection. PresenterAI was placed above one four-quadrant background containing light content, dark content, dense checkerboard detail, text, and color gradients. The review confirmed:

- substantially clearer pass-through than beta.3, with readable underlying fine text;
- localized saturated blue-violet emission rather than a full-window white wash;
- smooth transparent corner pixels with no rectangular Acrylic layer or stepped native shape;
- unchanged pass-through and shader rendering after ten hide/show cycles;
- reachable compact controls at 100%, 125%, 150%, and 200% effective scaling, with the single command surface wrapping to two rows at 200%.

The desktop captures contained the tester's local screen and were reviewed transiently. They were not saved, committed, or uploaded.

No prompt, response, transcript, audio, credential, or API key is part of this record.

## Acceptance boundary

A green beta.4 pull-request and post-merge workflow are still required because local Windows policy blocks the unsigned helper and NSIS intermediate. Only after both workflows pass is this build eligible for the same narrow closed manual-mode technical preview documented in `docs/manual/manual-mode-technical-preview.md`. Meet/audio reliability, physical devices, fullscreen behavior, and capture-protection compatibility remain separate unsigned gates.
