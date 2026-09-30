# Screenshot/model policy — beta.5

This delivery adds explicit, memory-only monitor snapshots, no-crop preview, Send/Retake/Discard, structured math/code/clarification solutions, and safe KaTeX rendering. Screen observations are not document citations. Screens are untrusted input and never executed.

Settings schema 6 preserves existing model choices and historical usage, defaults new installs to GPT-6 Luna / GPT-6.1 Sol and medium reasoning, and retires legacy caps/reservations. Reserved amounts are not treated as actual usage. Production requests omit `max_output_tokens`, retain `store:false`, and retain zero SDK retries. Historical M3 evaluation policy/reports are not rewritten: its isolated evaluation client retains explicit token limits for the authorized evaluation budget. The new production policy needs separately authorized live revalidation.

Price metadata was reviewed against official model pages on 2026-09-30: [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), and [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra). Exact unknown returned IDs remain Unpriced. No API key is accessed and no paid evaluation is part of this delivery.

## Local validation

- TypeScript passed; the full Vitest run passed 402/402 tests, with subsequent affected tests rerun after final lifecycle/accessibility changes.
- .NET passed 33/33; helper publishing and two WASAPI system-loopback cycles passed. The read-only environment probe reported SAC off and an unsigned ready helper; no security policy was modified.
- M4 and M7 offline checks passed 50/50; M6 preflight made zero network requests and still does not authorize its historical live campaign.
- Production build, beta.5 NSIS packaging/checksum, packaged FTS5/helper health, and clean install/launch/data-retention/uninstall passed.
- Upgrade remains blocked: the available local beta.4 installer did not install `PresenterAI.exe`. A genuine complete beta.4 artifact is required; this is not an upgrade pass.
- Dependency audit failed with pre-existing advisories (10 high, 4 moderate), including Electron/PDF/build dependencies. The added KaTeX dependency is not flagged. No unrelated dependency upgrades were made.
- Desktop visual/real snapshot checks and GUI-driven Playwright checks were not performed in this delivery; Computer Use was not authorized.

Desktop capture/restoration, monitor selection, formula legibility, and visual appearance need manual Windows verification. Existing unsigned-helper/App Control and outstanding milestone acceptance restrictions still apply. This document is not a formal M5–M8 acceptance.
