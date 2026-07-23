# Code-first, safe click-through, and hybrid liquid-glass validation

Delivery target: `0.2.0-beta.3`.

This change is a UX and presentation-layer hardening release. It does not accept any outstanding M0–M2 or M5–M8 manual gate, spend API credits, enable screen capture, or claim universal capture exclusion.

## Implemented invariants

- Code is the renderer, preload, and typed-controller default. Presenter is an explicit one-submission override and returns to Code immediately when submitted.
- Legacy IPC value `auto` remains accepted only as a temporary compatibility input and maps to Presenter.
- Developer responses use a distinct strict provider schema and local `responseStyle: "developer"` discriminator. The accepted presenter provider instructions and JSON schema are unchanged.
- Developer output is inert and copy-only: no HTML injection, execution, Run button, tool use, or code retention in conversation summaries.
- Click-through can be enabled only while the fixed `Ctrl+Shift+I` recovery shortcut is registered. Every enable requires an in-app confirmation that also identifies `Tray → Show PresenterAI`.
- Shortcut and tray recovery publish the resulting state to the renderer. An active high-contrast banner remains visible while mouse input is ignored.
- Settings schema v5 migrates v2–v4 data to `neonIntensity: 0.65` while preserving bounds, documents, consent, usage, session budget state, audio preferences, shortcuts, and project context.
- Neon intensity changes only the fixed blue-violet material emission. Text, code, cards, and control opacity remain independently readable.
- Supported Windows 11 builds request native Acrylic. A pointer-free, DPR-capped WebGL2 layer adds caustics and specular movement; unsupported WebGL or Windows versions use CSS/shader fallbacks.
- The renderer, native window region, and Acrylic surface use the same rounded boundary. Automated capture checks require transparent corner pixels.

## Non-billable evidence

| Gate | Result |
|---|---|
| TypeScript and production build | Passed |
| Vitest | 378/378 across 54 files |
| .NET helper | 33/33 |
| Playwright Electron | 10/10 |
| M4 retrieval | 50/50 top-five recall |
| M6 preflight | Passed with `networkRequests: 0`; paid campaign remains blocked |
| M7 offline | 50/50 |
| Dependency audit | 0 vulnerabilities |
| Packaging and packaged FTS | Passed; Electron 43.1.0, SQLite 3.53.1 with FTS5 |
| Helper smoke | Passed two real WASAPI loopback cycles at 16 kHz mono; packaged protocol-v2 helper located |
| Installer smoke | Passed clean install, launch, data preservation, and complete uninstall |
| Code Integrity diagnostic | Smart App Control `enforced`; helper `NotSigned`; controlled spawn returned protocol-v2 `ready` in this run |
| GitHub `build-and-package` | Required before merge |

Visual inspection was performed at the 1100×720 default and 680×420 minimum layout. The quick controls reflow at the minimum size, the single content viewport remains scrollable, native-capture corner alpha is zero at all four corners, and the shader remains behind readable local surfaces.

On 2026-07-23, the app was also launched four times with Windows/Electron device scale factors of 100%, 125%, 150%, and 200%. Each run reported the matching `devicePixelRatio` and display scale factor. With capture protection disabled only for this controlled visual check, full desktop-composited captures showed the requested Acrylic passthrough, readable blue-violet material, responsive controls, and a rounded outer edge without a rectangular backdrop or corner bleed at all four scales. The captures contained the tester's desktop and were reviewed transiently rather than committed or uploaded.

These local smoke results do not replace the original Meet, physical-device, fullscreen, or capture-protection matrices and do not formally accept M0–M2 or M5–M8.

## Remaining acceptance boundary

The formal milestone table in `plan-alignment.md` is unchanged. A green beta.3 workflow makes this build eligible for the same narrow closed manual-mode technical preview as earlier green builds; it does not validate Meet audio, physical devices, fullscreen behavior, or capture-protection compatibility.
