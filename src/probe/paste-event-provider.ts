import type { FormatObservation, ProviderProbeResult } from "../types";

export type PasteProbeState = "idle" | "armed";

export class PasteEventProvider {
  private state: PasteProbeState = "idle";
  private listener?: (event: ClipboardEvent) => void;

  getState(): PasteProbeState { return this.state; }

  async probe(): Promise<ProviderProbeResult> {
    return {
      provider: { name: "Paste Event", available: true, capability: this.state === "armed" ? "one-shot listener armed" : "available; arm next paste to capture metadata" },
      formats: [],
    };
  }

  arm(onCapture: (result: ProviderProbeResult) => void): void {
    this.disarm();
    this.state = "armed";
    this.listener = (event) => {
      // Observation only: this handler deliberately does not call preventDefault or stopPropagation.
      const data = event.clipboardData;
      const formats: FormatObservation[] = [];
      if (data) {
        for (const type of Array.from(data.types)) formats.push({ name: type, provider: "Paste Event", sizeBytes: null, readable: false, note: "Paste-event metadata only" });
        if (data.files.length > 0 && !formats.some((format) => format.name === "Files")) formats.push({ name: "Files", provider: "Paste Event", sizeBytes: null, readable: false, note: `${data.files.length} file metadata item(s)` });
      }
      this.disarm();
      // Let Obsidian complete its native paste action before a modal takes focus.
      window.setTimeout(() => onCapture({ provider: { name: "Paste Event", available: true, capability: "one-shot event captured" }, formats }), 0);
    };
    window.addEventListener("paste", this.listener, true);
  }

  disarm(): void {
    if (this.listener) window.removeEventListener("paste", this.listener, true);
    this.listener = undefined;
    this.state = "idle";
  }
}
