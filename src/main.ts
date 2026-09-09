import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { captureWindowsClipboard, readCaptured } from "./capture/windows-capture";
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
    this.addCommand({ id: "import-clipboard-preview", name: "Import Clipboard Preview (experimental)", callback: () => this.importClipboardPreview() });
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

  async importClipboardPreview(): Promise<void> {
    if (process.platform !== "win32") return void new Notice("ChemDraw Paste: experimental import is currently Windows-only.");
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !view.editor) return void new Notice("ChemDraw Paste: open a Markdown note before importing.");
    const stage = await mkdtemp(join(tmpdir(), "chemdraw-paste-"));
    try {
      const captured = await captureWindowsClipboard(stage);
      if (!captured.preview) return void new Notice("ChemDraw Paste: no CF_ENHMETAFILE preview was available.");
      const previewPath = await this.app.fileManager.getAvailablePathForAttachment("chemdraw-preview.png", view.file.path);
      await this.app.vault.createBinary(previewPath, await readCaptured(captured.preview.path));
      const sourcePaths: string[] = [];
      for (const source of captured.sources) {
        const path = await this.app.fileManager.getAvailablePathForAttachment(`chemdraw-${source.format.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.bin`, view.file.path);
        await this.app.vault.createBinary(path, await readCaptured(source.path)); sourcePaths.push(path);
      }
      view.editor.replaceSelection(`![[${previewPath}]]${sourcePaths.length ? `\n\nChemDraw source candidates: ${sourcePaths.map((path) => `[[${path}]]`).join(" ")}` : ""}`);
      new Notice(`ChemDraw Paste: inserted preview and saved ${sourcePaths.length} source candidate(s).`);
    } catch (error) { new Notice(`ChemDraw Paste import failed: ${error instanceof Error ? error.message : "unknown error"}`); }
    finally { await rm(stage, { recursive: true, force: true }); }
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
      .setName("Import clipboard preview (experimental)")
      .setDesc("Writes an EMF-derived PNG and raw ChemDraw source candidates, then inserts Markdown. Use only after copying from ChemDraw.")
      .addButton((button) => button.setButtonText("Import Preview").setWarning().onClick(() => void this.plugin.importClipboardPreview()));
    new Setting(containerEl)
      .setName("Show last diagnostic")
      .setDesc("Reopen the latest in-memory report; no data is saved to disk.")
      .addButton((button) => button.setButtonText("Show Last Diagnostic").onClick(() => this.plugin.showLastDiagnostic()));
  }
}

// Match the direct CommonJS entry shape used by the working desktop-only plugin in this vault.
module.exports = ChemDrawPastePlugin;
