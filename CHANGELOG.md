# Changelog

## 0.1.0 — Clipboard Probe

### Added

- Clipboard runtime diagnostics.
- Electron clipboard probe with runtime feature detection.
- One-shot paste-event metadata probe.
- Windows native clipboard format enumeration.
- Event-driven Windows clipboard metadata monitor with fail-open lifecycle handling.
- Safe format/size report modal.
- Experimental user-triggered EMF preview import with validated ChemDraw Interchange source.
- Conservative Smart Paste for confirmed ChemDraw clipboards, with an asynchronous Markdown marker transaction.
- ChemDraw Interchange clipboard data is validated and saved as the paired `*-source.cdx`; auxiliary Structure Data is no longer saved.
- ChemDraw assets are stored as monthly flat preview/source pairs with one shared object ID.

### Safety

- Read-only clipboard inspection.
- Probe mode has no payload persistence; experimental import persists only after an explicit user command.
- Ordinary non-ChemDraw paste is never intercepted; confirmed ChemDraw paste is intercepted for the experimental import path.
- No network or telemetry.
