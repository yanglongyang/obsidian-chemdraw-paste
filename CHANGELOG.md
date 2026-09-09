# Changelog

## 0.1.0 — Clipboard Probe

### Added

- Clipboard runtime diagnostics.
- Electron clipboard probe with runtime feature detection.
- One-shot paste-event metadata probe.
- Windows native clipboard format enumeration.
- Safe format/size report modal.
- Experimental user-triggered EMF preview import with raw ChemDraw source candidates.

### Safety

- Read-only clipboard inspection.
- Probe mode has no payload persistence; experimental import persists only after an explicit user command.
- No paste interception.
- No network or telemetry.
