import type { FormatObservation, ProviderProbeResult } from "../types";
import { errorSummary } from "../utils/format";

interface LegacyClipboard {
  availableFormats?: () => string[];
  readBuffer?: (format: string) => { length: number };
}

interface ModernClipboardItem {
  types: readonly string[];
  getType?: (type: string) => Promise<{ size?: number }>;
}

interface ModernClipboard {
  read?: () => Promise<ModernClipboardItem[]>;
}

function loadElectronClipboard(): LegacyClipboard | undefined {
  try {
    // Electron is intentionally feature-detected at runtime; importing it must not break plugin load.
    const electron = require("electron") as { clipboard?: LegacyClipboard };
    return electron.clipboard;
  } catch {
    return undefined;
  }
}

export class ElectronClipboardProvider {
  async probe(): Promise<ProviderProbeResult> {
    const clipboard = loadElectronClipboard();
    if (clipboard?.availableFormats) return this.probeLegacy(clipboard);

    const browserClipboard = (globalThis.navigator?.clipboard as ModernClipboard | undefined);
    if (browserClipboard?.read) return this.probeModern(browserClipboard);

    return { provider: { name: "Electron Clipboard", available: false, capability: "unavailable", error: "No renderer clipboard API is exposed by this Obsidian runtime." }, formats: [] };
  }

  private async probeLegacy(clipboard: LegacyClipboard): Promise<ProviderProbeResult> {
    try {
      const formats = clipboard.availableFormats?.() ?? [];
      const observations: FormatObservation[] = formats.map((name) => {
        try {
          // Only Buffer.length is retained. The Buffer is neither logged nor persisted.
          const sizeBytes = clipboard.readBuffer ? clipboard.readBuffer(name).length : null;
          return { name, provider: "Electron Clipboard", sizeBytes, readable: Boolean(clipboard.readBuffer) };
        } catch (error) {
          return { name, provider: "Electron Clipboard", sizeBytes: null, readable: false, error: errorSummary(error) };
        }
      });
      return { provider: { name: "Electron Clipboard", available: true, capability: "legacy availableFormats/readBuffer" }, formats: observations };
    } catch (error) {
      return { provider: { name: "Electron Clipboard", available: false, capability: "legacy error", error: errorSummary(error) }, formats: [] };
    }
  }

  private async probeModern(clipboard: ModernClipboard): Promise<ProviderProbeResult> {
    try {
      const items = await clipboard.read?.() ?? [];
      const observations: FormatObservation[] = [];
      for (const item of items) {
        for (const name of item.types) {
          try {
            const blob = item.getType ? await item.getType(name) : undefined;
            observations.push({ name, provider: "Electron Clipboard", sizeBytes: blob?.size ?? null, readable: Boolean(blob) });
          } catch (error) {
            observations.push({ name, provider: "Electron Clipboard", sizeBytes: null, readable: false, error: errorSummary(error) });
          }
        }
      }
      return { provider: { name: "Electron Clipboard", available: true, capability: "modern Clipboard.read" }, formats: observations };
    } catch (error) {
      return { provider: { name: "Electron Clipboard", available: false, capability: "modern error", error: errorSummary(error) }, formats: [] };
    }
  }
}
