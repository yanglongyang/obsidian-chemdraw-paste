import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { mergeProbeResults } from "./probe/clipboard-probe";
import { ElectronClipboardProvider } from "./probe/electron-provider";
import { PasteEventProvider } from "./probe/paste-event-provider";
import { WindowsClipboardProvider } from "./probe/windows-provider";
import type { ProbeReport, ProviderProbeResult } from "./types";
import { getObsidianVersion, getRuntimeInfo } from "./utils/runtime";
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
    this.addRibbonIcon("flask-conical", "ChemDraw Paste: Inspect Clipboard", () => void this.inspectClipboard());
    this.addSettingTab(new ChemDrawPasteControlTab(this.app, this));
    this.register(() => this.pasteProvider.disarm());
    new Notice("ChemDraw Paste: Clipboard Probe loaded. Use the ribbon flask icon or plugin settings if commands are not visible.");
  }

  onunload(): void { this.pasteProvider.disarm(); }

  async inspectClipboard(): Promise<void> {
    const report = await this.createReport();
    this.lastReport = report;
    this.safeDebug(report);
    new ClipboardProbeModal(this.app, report).open();
  }

  armNextPaste(): void {
    this.pasteProvider.arm(async (pasteResult) => {
      const report = await this.createReport(pasteResult);
      this.lastReport = report;
      this.safeDebug(report);
      new ClipboardProbeModal(this.app, report).open();
    });
    new Notice("ChemDraw Paste: armed for the next paste. Normal paste behavior will not be blocked.");
  }

  showLastDiagnostic(): void {
    if (!this.lastReport) return void new Notice("ChemDraw Paste: no in-memory diagnostic is available yet.");
    new ClipboardProbeModal(this.app, this.lastReport).open();
  }

  private async createReport(pasteResult?: ProviderProbeResult): Promise<ProbeReport> {
    const [electron, pasteIdle, windows] = await Promise.all([this.electronProvider.probe(), this.pasteProvider.probe(), this.windowsProvider.probe()]);
    const results = [electron, pasteResult ?? pasteIdle, windows];
    return { runtime: getRuntimeInfo(getObsidianVersion(this.app)), providers: results.map((result) => result.provider), formats: mergeProbeResults(results), timestamp: new Date() };
  }

  private safeDebug(report: ProbeReport): void {
    // Only format, size, provider, and error metadata may be written to the developer console.
    for (const format of report.formats) for (const observation of format.observations) console.debug("[ChemDraw Paste]", { format: format.name, size: observation.sizeBytes, provider: observation.provider, error: observation.error });
  }
}

/** No persisted settings: this tab is a discoverable control surface when command search is unavailable. */
class ChemDrawPasteControlTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ChemDrawPastePlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "ChemDraw Paste — Clipboard Probe" });
    containerEl.createEl("p", { text: "Read-only diagnostics. These controls never modify the clipboard or your note." });
    new Setting(containerEl)
      .setName("Inspect current clipboard")
      .setDesc("Run the Electron and Windows metadata probes now.")
      .addButton((button) => button.setButtonText("Inspect Clipboard").setCta().onClick(() => void this.plugin.inspectClipboard()));
    new Setting(containerEl)
      .setName("Probe next paste")
      .setDesc("Arm one normal paste. The next Ctrl+V is observed but never blocked.")
      .addButton((button) => button.setButtonText("Arm Next Paste").onClick(() => this.plugin.armNextPaste()));
    new Setting(containerEl)
      .setName("Show last diagnostic")
      .setDesc("Reopen the latest in-memory report; no data is saved to disk.")
      .addButton((button) => button.setButtonText("Show Last Diagnostic").onClick(() => this.plugin.showLastDiagnostic()));
  }
}

// Match the direct CommonJS entry shape used by the working desktop-only plugin in this vault.
module.exports = ChemDrawPastePlugin;
