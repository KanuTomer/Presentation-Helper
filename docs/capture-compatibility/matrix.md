# Capture compatibility matrix

Record Windows build, PresenterAI/Electron version, capture application version, GPU setting, monitor layout, and date for every run. First record the **protection OFF control**, then repeat with protection ON.

| Capture path | OFF control | ON result | Version / setup | Notes |
|---|---|---|---|---|
| Google Meet — entire screen | Untested | Untested | | Primary display-capture test |
| Google Meet — Chrome window | Untested | Untested | | Source selection may omit the overlay independently of affinity |
| Google Meet — Chrome tab | Untested | Untested | | Omission is expected and does not prove WDA support |
| Windows Snipping Tool | Untested | Untested | | |
| OBS Display Capture | Untested | Untested | | Record selected capture backend |
| OBS Window Capture — Chrome | Untested | Untested | | |
| OBS Window Capture — PresenterAI | Untested | Untested | | |

Allowed results: `overlay-absent`, `overlay-black`, `overlay-visible`, or `untested`.

Never describe an untested capture path as protected. `WDA_EXCLUDEFROMCAPTURE` is a request to supported Windows capture APIs, not DRM and not a guarantee against physical cameras or unsupported capture methods.
