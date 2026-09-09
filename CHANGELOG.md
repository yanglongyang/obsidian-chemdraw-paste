# Changelog

## 0.2.1 — Preview Interaction Closure

### Added

- Double-click managed flat-pair ChemDraw previews to open their paired CDX source with the Windows default application.
- Preview/source resolution based on the shared object ID, configured asset root, and monthly storage path.
- Source existence and CDX validation before opening.

### Preserved

- Direct Smart Paste and native clipboard monitoring.
- Monthly flat asset storage and configurable ChemDraw asset root.
- Ordinary non-ChemDraw paste behavior.
- No OLE, embedded editor, or ChemDraw executable path hardcoding.

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
