# Changelog

## 0.3.1 — Release Hardening

### Changed

- Manual clipboard refresh now updates only the derived preview PNG; the paired `source.cdx` is never replaced.
- Automatic rendering preserves the existing preview canvas while fitting new ChemDraw output proportionally with white padding.
- Automatic renders are serialized globally, use a stable CDX snapshot, and continue processing later sources after an isolated task failure.
- Settings and package metadata now describe the import, editable-source, and automatic synchronization workflow.

### Tests

- Added regression coverage for debounce, pending rerenders, disabled synchronization, stale-preview decisions, queue serialization, deduplication, and failure isolation.

## 0.3.0 — Automatic Preview Synchronization

### Added

- Verified local ChemDraw COM rendering from standalone CDX to PNG.
- Debounced source watcher with stable-file and CDX validation gates.
- Automatic preview replacement through the Obsidian Vault API.
- Startup reconciliation for stale managed previews.
- Automatic preview refresh setting, enabled by default.

### Safety

- Source CDX files are never modified by the renderer.
- Rendering uses a temporary PNG and preserves the old preview on failure.
- No clipboard automation, UI simulation, ChemDraw process termination, or Markdown rewriting.

## 0.2.2 — Refresh Existing ChemDraw Object

### Added

- Refresh an existing managed preview/source pair from the current ChemDraw clipboard.
- Add a managed-preview-only context-menu action, `Refresh Preview from ChemDraw Clipboard`.
- Preserve object ID, file paths, and Markdown while replacing the preview in place.

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
