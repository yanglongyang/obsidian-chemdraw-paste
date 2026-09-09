import { Notice, Plugin } from "obsidian";
import { mergeProbeResults } from "./probe/clipboard-probe";
import { ElectronClipboardProvider } from "./probe/electron-provider";
import { PasteEventProvider } from "./probe/paste-event-provider";
import { WindowsClipboardProvider } from "./probe/windows-provider";
import type { ProbeReport, ProviderProbeResult } from "./types";
import { getRuntimeInfo } from "./utils/runtime";
import { ClipboardProbeModal } from "./ui/probe-modal";

class ChemDrawPastePlugin extends Plugin {
  private readonly electronProvider = new ElectronClipboardProvider();
  private readonly pasteProvider = new PasteEventProvider();
  private readonly windowsProvider = new WindowsClipboardProvider();
  private lastReport?: ProbeReport;

  async onload(): Promise<void> {
    this.addCommand({ id: "inspect-clipboard", name: "Inspect Clipboard", callback: () => this.inspectClipboard() });
    this.addCommand({ id: "probe-next-paste", name: "Probe Next Paste", callback: () => this.armNextPaste() });
    this.addCommand({ id: "show-last-diagnostic", name: "Show Last Diagnostic", callback: () => this.showLastDiagnostic() });
    this.register(() => this.pasteProvider.disarm());
    new Notice("ChemDraw Paste: Clipboard Probe loaded. Use Command Palette to inspect or arm the next paste.");
  }

  onunload(): void { this.pasteProvider.disarm(); }

  private async inspectClipboard(): Promise<void> {
    const report = await this.createReport();
    this.lastReport = report;
    this.safeDebug(report);
    new ClipboardProbeModal(this.app, report).open();
  }

  private armNextPaste(): void {
    this.pasteProvider.arm(async (pasteResult) => {
      const report = await this.createReport(pasteResult);
      this.lastReport = report;
      this.safeDebug(report);
      new ClipboardProbeModal(this.app, report).open();
    });
    new Notice("ChemDraw Paste: armed for the next paste. Normal paste behavior will not be blocked.");
  }

  private showLastDiagnostic(): void {
    if (!this.lastReport) return void new Notice("ChemDraw Paste: no in-memory diagnostic is available yet.");
    new ClipboardProbeModal(this.app, this.lastReport).open();
  }

  private async createReport(pasteResult?: ProviderProbeResult): Promise<ProbeReport> {
    const [electron, pasteIdle, windows] = await Promise.all([this.electronProvider.probe(), this.pasteProvider.probe(), this.windowsProvider.probe()]);
    const results = [electron, pasteResult ?? pasteIdle, windows];
    return { runtime: getRuntimeInfo((this.app as unknown as { version?: string }).version ?? "unknown"), providers: results.map((result) => result.provider), formats: mergeProbeResults(results), timestamp: new Date() };
  }

  private safeDebug(report: ProbeReport): void {
    // Only format, size, provider, and error metadata may be written to the developer console.
    for (const format of report.formats) for (const observation of format.observations) console.debug("[ChemDraw Paste]", { format: format.name, size: observation.sizeBytes, provider: observation.provider, error: observation.error });
  }
}

// Match the direct CommonJS entry shape used by the working desktop-only plugin in this vault.
module.exports = ChemDrawPastePlugin;
