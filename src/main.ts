import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { captureWindowsClipboard, readCaptured } from "./capture/windows-capture";
import { isValidCDX } from "./capture/cdx";
import { NativeClipboardMonitor } from "./capture/windows-clipboard-monitor";
import { isChemDrawClipboard } from "./paste/chemdraw-detector";
import { mergeProbeResults } from "./probe/clipboard-probe";
import { ElectronClipboardProvider } from "./probe/electron-provider";
import { PasteEventProvider } from "./probe/paste-event-provider";
import { WindowsClipboardProvider } from "./probe/windows-provider";
import type { ProbeReport, ProviderProbeResult } from "./types";
import { getObsidianVersion, getRuntimeInfo } from "./utils/runtime";
import { chemDrawMonthFolder, makeChemDrawBundleId, normalizeChemDrawAssetFolder } from "./utils/vault-path";
import { ClipboardProbeModal } from "./ui/probe-modal";

interface PasteTarget {
  view: MarkdownView;
  marker?: string;
}

interface ChemDrawPasteSettings {
  assetFolder: string;
}

const DEFAULT_SETTINGS: ChemDrawPasteSettings = { assetFolder: "ChemDraw" };

class ChemDrawPastePlugin extends Plugin {
  private readonly electronProvider = new ElectronClipboardProvider();
  private readonly pasteProvider = new PasteEventProvider();
  private readonly windowsProvider = new WindowsClipboardProvider();
  private readonly nativeClipboardMonitor = new NativeClipboardMonitor();
  private pluginSettings: ChemDrawPasteSettings = { ...DEFAULT_SETTINGS };
  private lastReport?: ProbeReport;

  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<ChemDrawPasteSettings> | null;
    try {
      this.pluginSettings.assetFolder = normalizeChemDrawAssetFolder(saved?.assetFolder ?? DEFAULT_SETTINGS.assetFolder);
    } catch {
      this.pluginSettings.assetFolder = DEFAULT_SETTINGS.assetFolder;
    }
    this.addCommand({ id: "inspect-clipboard", name: "Inspect Clipboard", callback: () => this.inspectClipboard() });
    this.addCommand({ id: "probe-next-paste", name: "Probe Next Paste", callback: () => this.armNextPaste() });
    this.addCommand({ id: "show-last-diagnostic", name: "Show Last Diagnostic", callback: () => this.showLastDiagnostic() });
    this.addCommand({ id: "import-clipboard-preview", name: "Import Clipboard Preview (experimental)", callback: () => this.importClipboardPreview() });
    this.addRibbonIcon("flask-conical", "ChemDraw Paste: Inspect Clipboard", () => void this.inspectClipboard());
    this.addSettingTab(new ChemDrawPasteControlTab(this.app, this));
    this.register(() => this.pasteProvider.disarm());
    void this.nativeClipboardMonitor.start();
    this.register(() => this.nativeClipboardMonitor.stop());
    const smartPasteListener = (event: ClipboardEvent) => {
      // The browser fast path covers formats Chromium exposes. The native cache
      // covers Windows registered formats hidden from ClipboardEvent. Both checks
      // are synchronous; an unknown/unavailable state always fails open.
      const browserDetected = isChemDrawClipboard(event);
      const nativeDetected = this.nativeClipboardMonitor.getState().available && this.nativeClipboardMonitor.getState().hasChemDraw;
      if (!browserDetected && !nativeDetected) return;
      const target = this.capturePasteTarget();
      if (!target) return;
      event.preventDefault();
      void this.importClipboardPreview(target);
    };
    window.addEventListener("paste", smartPasteListener, true);
    this.register(() => window.removeEventListener("paste", smartPasteListener, true));
    new Notice("ChemDraw Paste: Clipboard Probe loaded. Use the ribbon flask icon or plugin settings if commands are not visible.");
  }

  onunload(): void {
    this.pasteProvider.disarm();
    this.nativeClipboardMonitor.stop();
  }

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

  async importClipboardPreview(target?: PasteTarget): Promise<void> {
    if (process.platform !== "win32") return void new Notice("ChemDraw Paste: experimental import is currently Windows-only.");
    const view = target?.view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !view.editor) return void new Notice("ChemDraw Paste: open a Markdown note before importing.");
    const stage = await mkdtemp(join(tmpdir(), "chemdraw-paste-"));
    const createdFiles: string[] = [];
    const createdFolders: string[] = [];
    try {
      const captured = await captureWindowsClipboard(stage);
      if (!captured.preview) throw new Error("no CF_ENHMETAFILE preview was available");
      const validSources: Array<{ data: ArrayBuffer }> = [];
      for (const source of captured.sources) {
        const data = await readCaptured(source.path);
        if (source.format === "ChemDraw Interchange Format" && isValidCDX(data)) validSources.push({ data });
      }
      if (target?.marker && validSources.length === 0) throw new Error("no valid ChemDraw CDX source was available");
      const capturedAt = new Date();
      const bundleRoot = await this.createUniqueBundlePath(capturedAt, createdFolders);
      const previewPath = `${bundleRoot}/preview.png`;
      createdFiles.push(previewPath);
      await this.app.vault.createBinary(previewPath, await readCaptured(captured.preview.path));
      const sourcePaths: string[] = [];
      for (const source of validSources) {
        const path = `${bundleRoot}/source.cdx`;
        createdFiles.push(path);
        await this.app.vault.createBinary(path, source.data); sourcePaths.push(path);
      }
      const markdown = `![[${previewPath}]]`;
      if (target?.marker) {
        if (!this.replaceMarker(view, target.marker, markdown)) throw new Error("paste target was removed before import completed");
      } else {
        view.editor.replaceSelection(markdown);
      }
      new Notice(`ChemDraw Paste: inserted preview bundle ${bundleRoot}${sourcePaths.length ? " with editable CDX source" : ""}.`);
    } catch (error) {
      if (target?.marker) this.replaceMarker(view, target.marker, "");
      await this.rollbackCreatedAssets(createdFiles, createdFolders);
      new Notice(`ChemDraw Paste import failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    finally { await rm(stage, { recursive: true, force: true }); }
  }

  async setAssetFolder(value: string): Promise<boolean> {
    try {
      this.pluginSettings.assetFolder = normalizeChemDrawAssetFolder(value);
      await this.saveData(this.pluginSettings);
      return true;
    } catch (error) {
      new Notice(`ChemDraw Paste: invalid asset folder — ${error instanceof Error ? error.message : "use a Vault-relative path"}`);
      return false;
    }
  }

  getAssetFolder(): string { return this.pluginSettings.assetFolder; }

  private async createUniqueBundlePath(date: Date, createdFolders: string[]): Promise<string> {
    const monthRoot = `${this.pluginSettings.assetFolder}/${chemDrawMonthFolder(date)}`;
    await this.ensureFolder(this.pluginSettings.assetFolder, createdFolders);
    await this.ensureFolder(monthRoot, createdFolders);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bundle = `${monthRoot}/${makeChemDrawBundleId(date)}`;
      if (!this.app.vault.getAbstractFileByPath(bundle)) {
        await this.ensureFolder(bundle, createdFolders);
        return bundle;
      }
    }
    throw new Error("could not allocate a unique ChemDraw bundle folder");
  }

  private async ensureFolder(path: string, createdFolders: string[]): Promise<void> {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
        createdFolders.push(current);
      } catch (error) {
        if (!this.app.vault.getAbstractFileByPath(current)) throw error;
      }
    }
  }

  private async rollbackCreatedAssets(files: string[], folders: string[]): Promise<void> {
    for (const path of [...files].reverse()) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) await this.app.vault.delete(file).catch(() => undefined);
    }
    for (const path of [...folders].reverse()) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder && folder.children.length === 0) await this.app.vault.delete(folder).catch(() => undefined);
    }
  }

  private capturePasteTarget(): PasteTarget | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !view.editor) return undefined;
    const marker = `<!-- chemdraw-paste:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)} -->`;
    view.editor.replaceSelection(marker);
    return { view, marker };
  }

  private replaceMarker(view: MarkdownView, marker: string, replacement: string): boolean {
    const editor = view.editor;
    const value = editor.getValue();
    const offset = value.indexOf(marker);
    if (offset < 0) return false;
    const start = this.offsetToPosition(value, offset);
    const end = this.offsetToPosition(value, offset + marker.length);
    editor.replaceRange(replacement, start, end);
    return true;
  }

  private offsetToPosition(value: string, offset: number): { line: number; ch: number } {
    const prefix = value.slice(0, offset);
    const lines = prefix.split("\n");
    return { line: lines.length - 1, ch: lines[lines.length - 1].length };
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
      .setName("ChemDraw asset folder")
      .setDesc("Vault-relative folder for new ChemDraw/YYYY-MM/bundle attachments. Changing this affects new pastes only.")
      .addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.assetFolder).setValue(this.plugin.getAssetFolder()).onChange((value) => void this.plugin.setAssetFolder(value)));
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
      .setDesc("Ctrl+V is intercepted only when the native Windows clipboard cache confirms ChemDraw. A manual import writes a managed preview bundle and validated CDX source when available.")
      .addButton((button) => button.setButtonText("Import Preview").setWarning().onClick(() => void this.plugin.importClipboardPreview()));
    new Setting(containerEl)
      .setName("Show last diagnostic")
      .setDesc("Reopen the latest in-memory report; no data is saved to disk.")
      .addButton((button) => button.setButtonText("Show Last Diagnostic").onClick(() => this.plugin.showLastDiagnostic()));
  }
}

// Match the direct CommonJS entry shape used by the working desktop-only plugin in this vault.
module.exports = ChemDrawPastePlugin;
