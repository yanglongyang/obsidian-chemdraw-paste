# ChemDraw Paste — Clipboard Probe v0.1.0

`ChemDraw Paste` is a standalone Obsidian Desktop clipboard probe with an experimental, user-triggered import MVP. On the validated Windows + ChemDraw 25 path, it saves `ChemDraw Interchange Format` as a `.cdx` source file.

## What it does

- Shows runtime metadata: platform, architecture, Obsidian, Electron, Chrome, and Node versions.
- Safely probes the Electron clipboard API when the current runtime exposes it.
- Enumerates Windows clipboard format names using a short, fixed PowerShell/Win32 helper.
- Can arm one normal Obsidian paste event and report its exposed metadata after the paste completes.
- Labels text, HTML, image, metafile, file, custom, and unknown formats conservatively.

## Privacy boundary

- It does not modify, clear, or replace the clipboard.
- The **Probe** commands do not save clipboard payloads, attachments, source files, or diagnostics to disk.
- The **Probe** commands do not read or show clipboard text, binary data, CDX/CDXML, image data, or file contents.
- The **Import Clipboard Preview (experimental)** command is the sole exception: after an explicit user click, it writes an EMF-derived PNG, a `.cdx` source file, and inserts Markdown in the active note.
- It never modifies, clears, or replaces the system clipboard, and it does not intercept normal paste behavior.
- It has no telemetry, network, upload, cloud, AI, or database functionality.

The report retains only format names, provider names, byte sizes when a runtime safely exposes them, and error/capability metadata. A legacy Electron buffer is retained only long enough to obtain its length and is never logged or stored.

## Install for local development

1. Run `npm install` and `npm run build`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into an Obsidian vault's `.obsidian/plugins/chemdraw-paste/` directory.
3. Enable **ChemDraw Paste** in Obsidian's Community plugins view.

## Commands

- **ChemDraw Paste: Inspect Clipboard** — immediately runs every available read-only provider and opens a diagnostic modal.
- **ChemDraw Paste: Probe Next Paste** — arms exactly one paste listener. Return to a Markdown editor and paste normally; the plugin observes event metadata only and opens the report after Obsidian receives the paste.
- **ChemDraw Paste: Show Last Diagnostic** — reopens the last in-memory report. Nothing survives a plugin reload.
- **ChemDraw Paste: Import Clipboard Preview (experimental)** — explicitly captures `CF_ENHMETAFILE` plus `ChemDraw Interchange Format`, creates PNG and `.cdx` attachments, and inserts a preview. It must be run from an open Markdown note.

## Manual diagnostic protocol

Copy each item in ChemDraw, then use **Inspect Clipboard**. Record only the visible format names, providers, and sizes—never clipboard contents.

| Test | Clipboard source |
| --- | --- |
| A | Benzene / a single molecule |
| B | Substrate → product reaction |
| C | Reaction with reagent text and temperature |
| D | Multiple structures and arrows |
| E | Colored structure or annotations |
| Control 1 | Plain text |
| Control 2 | Browser HTML |
| Control 3 | PNG image |

Repeat relevant tests with **Probe Next Paste** to compare what the browser paste event sees with what Electron and the Windows native enumerator see. Confirm each paste behaves exactly as it did before the plugin was installed.

## Known limitations

- Clipboard APIs available to plugins depend on Obsidian's current Electron runtime.
- Some native Windows formats may be visible only through the Windows probe.
- The Windows helper enumerates format names only; it intentionally does not read native payloads, so those sizes are shown as `unknown`.
- The experimental import has been verified with a benzene selection in ChemDraw 25; a full reaction scheme remains to be validated.
- v0.1.0 does not intercept Ctrl+V or implement embedded OLE editing.
- Windows is the target platform. On macOS and Linux the Windows provider is gracefully unavailable; other providers may still run.

## Development checks

```text
npm install
npm test
npm run build
npm run lint
```

The unit tests do not require ChemDraw or access to the system clipboard.
