import { App, FileSystemAdapter, MarkdownView, Menu, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { captureWindowsClipboard, readCaptured } from "./capture/windows-capture";
import { isValidCDX } from "./capture/cdx";
import { NativeClipboardMonitor } from "./capture/windows-clipboard-monitor";
import { managedPreviewPathFromMarkdownLine, resolveChemDrawPreviewPath, resolveChemDrawSourcePath } from "./interaction/preview-source";
import { openSourceWithDefaultApp } from "./interaction/source-opener";
import { isChemDrawClipboard } from "./paste/chemdraw-detector";
import { mergeProbeResults } from "./probe/clipboard-probe";
import { ElectronClipboardProvider } from "./probe/electron-provider";
import { PasteEventProvider } from "./probe/paste-event-provider";
import { WindowsClipboardProvider } from "./probe/windows-provider";
import type { ProbeReport, ProviderProbeResult } from "./types";
import { getObsidianVersion, getRuntimeInfo } from "./utils/runtime";
import { chemDrawMonthFolder, makeChemDrawBundleId, normalizeChemDrawAssetFolder } from "./utils/vault-path";
import { ClipboardProbeModal } from "./ui/probe-modal";
import { WindowsChemDrawRenderer, getPngDimensions, isPng } from "./render/windows-chemdraw-renderer";
import { SerialRefreshQueue } from "./refresh/serial-refresh-queue";

interface PasteTarget {
  view: MarkdownView;
  marker?: string;
}

interface ChemDrawPasteSettings {
  assetFolder: string;
  autoRefresh: boolean;
}

const DEFAULT_SETTINGS: ChemDrawPasteSettings = { assetFolder: "ChemDraw", autoRefresh: true };

interface RefreshState {
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  pending: boolean;
}

class ChemDrawPastePlugin extends Plugin {
  private readonly electronProvider = new ElectronClipboardProvider();
  private readonly pasteProvider = new PasteEventProvider();
  private readonly windowsProvider = new WindowsClipboardProvider();
  private readonly nativeClipboardMonitor = new NativeClipboardMonitor();
  private readonly renderer = new WindowsChemDrawRenderer();
  private pluginSettings: ChemDrawPasteSettings = { ...DEFAULT_SETTINGS };
  private readonly refreshStates = new Map<string, RefreshState>();
  private readonly automaticRefreshQueue = new SerialRefreshQueue(async (sourcePath) => {
    const state = this.refreshStates.get(sourcePath);
    if (state) await this.processAutomaticRefresh(sourcePath, state);
  });
  private lastReport?: ProbeReport;

  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<ChemDrawPasteSettings> | null;
    try {
      this.pluginSettings.assetFolder = normalizeChemDrawAssetFolder(saved?.assetFolder ?? DEFAULT_SETTINGS.assetFolder);
      this.pluginSettings.autoRefresh = saved?.autoRefresh !== false;
    } catch {
      this.pluginSettings.assetFolder = DEFAULT_SETTINGS.assetFolder;
    }
    this.addCommand({ id: "inspect-clipboard", name: "Inspect Clipboard", callback: () => this.inspectClipboard() });
    this.addCommand({ id: "probe-next-paste", name: "Probe Next Paste", callback: () => this.armNextPaste() });
    this.addCommand({ id: "show-last-diagnostic", name: "Show Last Diagnostic", callback: () => this.showLastDiagnostic() });
    this.addCommand({ id: "import-clipboard-preview", name: "Import Clipboard Preview (experimental)", callback: () => this.importClipboardPreview() });
    this.addCommand({ id: "refresh-current-chemdraw-preview", name: "Refresh Current ChemDraw Preview", callback: () => this.refreshCurrentChemDrawPreview() });
    this.addRibbonIcon("flask-conical", "ChemDraw Paste: Inspect Clipboard", () => void this.inspectClipboard());
    this.addSettingTab(new ChemDrawPasteControlTab(this.app, this));
    this.register(() => this.pasteProvider.disarm());
    void this.nativeClipboardMonitor.start();
    this.register(() => this.nativeClipboardMonitor.stop());
    this.registerEvent(this.app.vault.on("modify", (file) => this.scheduleAutomaticRefresh(file.path)));
    if (this.pluginSettings.autoRefresh) void this.reconcileStalePreviews();
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
    this.registerDomEvent(document, "dblclick", (event) => void this.handlePreviewDoubleClick(event));
    this.registerDomEvent(document, "contextmenu", (event) => this.handlePreviewContextMenu(event));
    new Notice("ChemDraw Paste: Clipboard Probe loaded. Use the ribbon flask icon or plugin settings if commands are not visible.");
  }

  onunload(): void {
    this.pasteProvider.disarm();
    this.nativeClipboardMonitor.stop();
    for (const state of this.refreshStates.values()) if (state.timer) clearTimeout(state.timer);
    this.refreshStates.clear();
    this.automaticRefreshQueue.clear();
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
      if (validSources.length === 0) throw new Error("no valid ChemDraw CDX source was available");
      const capturedAt = new Date();
      const paths = await this.createUniquePairPaths(capturedAt, createdFolders);
      const previewPath = paths.previewPath;
      createdFiles.push(previewPath, paths.sourcePath);
      await this.app.vault.createBinary(previewPath, await readCaptured(captured.preview.path));
      await this.app.vault.createBinary(paths.sourcePath, validSources[0].data);
      const markdown = `![[${previewPath}]]`;
      if (target?.marker) {
        if (!this.replaceMarker(view, target.marker, markdown)) throw new Error("paste target was removed before import completed");
      } else {
        view.editor.replaceSelection(markdown);
      }
      new Notice(`ChemDraw Paste: inserted preview/source pair ${paths.previewPath}.`);
    } catch (error) {
      if (target?.marker) this.replaceMarker(view, target.marker, "");
      await this.rollbackCreatedAssets(createdFiles, createdFolders);
      new Notice(`ChemDraw Paste import failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    finally { await rm(stage, { recursive: true, force: true }); }
  }

  async refreshCurrentChemDrawPreview(): Promise<void> {
    if (process.platform !== "win32") return void new Notice("ChemDraw Paste: refresh is currently Windows-only.");
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !view.editor) return void new Notice("ChemDraw Paste: place the cursor on a managed preview embed first.");
    const previewPath = managedPreviewPathFromMarkdownLine(view.editor.getLine(view.editor.getCursor("head").line), this.getAssetFolder());
    if (!previewPath) return void new Notice("ChemDraw Paste: place the cursor on a managed ChemDraw preview first.");
    await this.refreshChemDrawPreviewPath(previewPath);
  }

  private async refreshChemDrawPreviewPath(previewPath: string): Promise<void> {
    if (process.platform !== "win32") return void new Notice("ChemDraw Paste: refresh is currently Windows-only.");
    const sourcePath = resolveChemDrawSourcePath(previewPath, this.getAssetFolder());
    if (!sourcePath) return void new Notice("ChemDraw Paste: could not resolve the paired CDX source.");
    const previewFile = this.app.vault.getAbstractFileByPath(previewPath);
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(previewFile instanceof TFile) || !(sourceFile instanceof TFile)) return void new Notice("ChemDraw Paste: the paired preview or source.cdx is missing.");
    const stage = await mkdtemp(join(tmpdir(), "chemdraw-refresh-"));
    try {
      const captured = await captureWindowsClipboard(stage);
      if (!captured.preview) throw new Error("no CF_ENHMETAFILE preview was available");
      const previewData = await readCaptured(captured.preview.path);
      const oldPreview = await this.app.vault.readBinary(previewFile);
      try {
        await this.app.vault.modifyBinary(previewFile, previewData);
      } catch (error) {
        await this.app.vault.modifyBinary(previewFile, oldPreview).catch(() => undefined);
        throw error;
      }
      this.refreshRenderedPreviews(previewPath);
      new Notice("ChemDraw Paste: updated the selected preview; source.cdx was left unchanged.");
    } catch (error) {
      new Notice(`ChemDraw Paste refresh failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  private handlePreviewContextMenu(event: MouseEvent): void {
    const image = this.imageFromEvent(event);
    if (!image) return;
    const previewPath = this.resolveImageVaultPath(image);
    if (!previewPath || !resolveChemDrawSourcePath(previewPath, this.getAssetFolder())) return;
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Refresh Preview from ChemDraw Clipboard").setIcon("refresh-cw").onClick(() => void this.refreshChemDrawPreviewPath(previewPath)));
    menu.showAtMouseEvent(event);
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

  async setAutoRefresh(value: boolean): Promise<void> {
    this.pluginSettings.autoRefresh = value;
    await this.saveData(this.pluginSettings);
    if (value) void this.reconcileStalePreviews();
    else this.automaticRefreshQueue.clear();
  }

  getAutoRefresh(): boolean { return this.pluginSettings.autoRefresh; }

  private scheduleAutomaticRefresh(sourcePath: string, delay = 750): void {
    if (process.platform !== "win32" || !this.pluginSettings.autoRefresh || !resolveChemDrawPreviewPath(sourcePath, this.getAssetFolder())) return;
    const state = this.refreshStates.get(sourcePath) ?? { running: false, pending: false };
    this.refreshStates.set(sourcePath, state);
    if (state.running) { state.pending = true; return; }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.enqueueAutomaticRefresh(sourcePath, state);
    }, delay);
  }

  private enqueueAutomaticRefresh(sourcePath: string, state: RefreshState): void {
    if (!this.pluginSettings.autoRefresh) return;
    if (state.running) { state.pending = true; return; }
    this.automaticRefreshQueue.enqueue(sourcePath);
  }

  private async processAutomaticRefresh(sourcePath: string, state: RefreshState): Promise<void> {
    if (state.running || !this.pluginSettings.autoRefresh) return;
    state.running = true;
    let stage: string | undefined;
    try {
      stage = await mkdtemp(join(tmpdir(), "chemdraw-render-"));
      const stable = await this.readStableCDX(sourcePath);
      const stableSourcePath = join(stage, "source.cdx");
      await writeFile(stableSourcePath, new Uint8Array(stable));
      const previewPath = resolveChemDrawPreviewPath(sourcePath, this.getAssetFolder());
      if (!previewPath) return;
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) throw new Error("the current vault adapter does not expose local file paths");
      const preview = this.app.vault.getAbstractFileByPath(previewPath);
      const previousPreview = preview instanceof TFile ? await this.app.vault.readBinary(preview) : undefined;
      const targetSize = previousPreview ? getPngDimensions(new Uint8Array(previousPreview)) : undefined;
      const rendered = await this.renderer.render(stableSourcePath, stage, targetSize);
      const image = await readCaptured(rendered.outputPath);
      if (!isPng(new Uint8Array(image)) || image.byteLength < 128) throw new Error("renderer output failed PNG validation");
      if (preview instanceof TFile) await this.app.vault.modifyBinary(preview, image);
      else await this.app.vault.createBinary(previewPath, image);
      this.refreshRenderedPreviews(previewPath);
      console.debug("[ChemDraw Paste] automatic preview refresh", { sourcePath, previewPath, backend: rendered.backend, sizeBytes: rendered.sizeBytes });
    } catch (error) {
      new Notice(`ChemDraw Paste: Automatic preview refresh failed for ${sourcePath.split("/").pop() ?? "source"}.`);
      console.debug("[ChemDraw Paste] automatic preview refresh failed", { sourcePath, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
      state.running = false;
      if (state.pending) {
        state.pending = false;
        this.scheduleAutomaticRefresh(sourcePath, 0);
      }
    }
  }

  private async readStableCDX(sourcePath: string): Promise<ArrayBuffer> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = await this.app.vault.adapter.stat(sourcePath);
      if (!before) throw new Error("source.cdx is missing");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = await this.app.vault.adapter.stat(sourcePath);
      if (after && before.size === after.size && before.mtime === after.mtime) {
        const source = this.app.vault.getAbstractFileByPath(sourcePath);
        if (source instanceof TFile) {
          const data = await this.app.vault.readBinary(source);
          if (isValidCDX(data)) return data;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("source.cdx did not become stable and valid");
  }

  private async reconcileStalePreviews(): Promise<void> {
    const root = this.getAssetFolder();
    try {
      const listing = await this.app.vault.adapter.list(root);
      for (const folder of listing.folders.filter((path) => /^\d{4}-\d{2}$/.test(path.slice(root.length + 1)))) {
        const month = await this.app.vault.adapter.list(folder);
        for (const sourcePath of month.files) {
          if (!resolveChemDrawPreviewPath(sourcePath, root)) continue;
          const previewPath = resolveChemDrawPreviewPath(sourcePath, root);
          if (!previewPath) continue;
          const sourceStat = await this.app.vault.adapter.stat(sourcePath);
          const previewStat = await this.app.vault.adapter.stat(previewPath);
          if (!previewStat || (sourceStat && sourceStat.mtime > previewStat.mtime)) this.scheduleAutomaticRefresh(sourcePath, 0);
        }
      }
    } catch (error) {
      console.debug("[ChemDraw Paste] stale preview reconciliation skipped", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Obsidian's image resource URL is stable for a given vault path. After an
   * in-place binary replacement, an already-rendered embed can therefore keep
   * showing the previous decoded image from Chromium's cache. Refresh only
   * managed embeds that reference this path; do not reload the whole workspace
   * or modify the Markdown source.
   */
  private refreshRenderedPreviews(previewPath: string): void {
    const adapter = this.app.vault.adapter;
    const resourcePath = adapter.getResourcePath(previewPath);
    const resourceBase = resourcePath.split("?", 1)[0];
    const cacheBust = `chemdraw-refresh=${Date.now()}`;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (!view.getViewData().includes(previewPath)) return;

      // Reading mode and source/preview transitions rebuild their own image
      // elements. Request a light preview rerender first, then handle any
      // currently mounted image element (including Live Preview widgets).
      try { view.previewMode.rerender(false); } catch { /* best effort */ }
      const images = view.containerEl.querySelectorAll("img");
      for (const image of Array.from(images)) {
        const current = image.currentSrc || image.src;
        if (!current) continue;
        const currentBase = current.split("?", 1)[0];
        if (currentBase !== resourceBase) continue;
        image.src = `${resourceBase}?${cacheBust}`;
      }
    });
  }

  private async createUniquePairPaths(date: Date, createdFolders: string[]): Promise<{ previewPath: string; sourcePath: string }> {
    const monthRoot = `${this.pluginSettings.assetFolder}/${chemDrawMonthFolder(date)}`;
    await this.ensureFolder(this.pluginSettings.assetFolder, createdFolders);
    await this.ensureFolder(monthRoot, createdFolders);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = makeChemDrawBundleId(date);
      const previewPath = `${monthRoot}/${id}-preview.png`;
      const sourcePath = `${monthRoot}/${id}-source.cdx`;
      if (!this.app.vault.getAbstractFileByPath(previewPath) && !this.app.vault.getAbstractFileByPath(sourcePath)) {
        return { previewPath, sourcePath };
      }
    }
    throw new Error("could not allocate a unique ChemDraw preview/source pair");
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

  private async handlePreviewDoubleClick(event: MouseEvent): Promise<void> {
    const image = this.imageFromEvent(event);
    if (!image) return;
    const previewPath = this.resolveImageVaultPath(image);
    if (!previewPath) return;
    const sourcePath = resolveChemDrawSourcePath(previewPath, this.getAssetFolder());
    if (!sourcePath) return;
    event.preventDefault();
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFile)) {
      new Notice("ChemDraw Paste: Paired source.cdx is missing or invalid.");
      return;
    }
    try {
      const data = await this.app.vault.readBinary(source);
      if (!isValidCDX(data)) {
        new Notice("ChemDraw Paste: Paired source.cdx is missing or invalid.");
        return;
      }
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) throw new Error("the current vault adapter does not expose a local file path");
      await openSourceWithDefaultApp(adapter.getFullPath(sourcePath));
    } catch (error) {
      new Notice(`ChemDraw Paste: Could not open the CDX source with the default Windows application.${error instanceof Error ? ` ${error.message}` : ""}`);
    }
  }

  private imageFromEvent(event: MouseEvent): HTMLImageElement | null {
    const target = event.target;
    if (target instanceof HTMLImageElement) return target;
    return target instanceof HTMLElement ? target.closest("img") : null;
  }

  private resolveImageVaultPath(image: HTMLImageElement): string | undefined {
    const candidates: string[] = [];
    let node: HTMLElement | null = image;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      for (const attribute of ["data-path", "data-src", "href"]) {
        const value = node.getAttribute(attribute);
        if (value) candidates.push(value);
      }
    }
    const alt = image.getAttribute("alt");
    if (alt) candidates.push(alt);
    for (const candidate of candidates) {
      const file = this.app.vault.getAbstractFileByPath(candidate.replace(/\\/g, "/"));
      if (file instanceof TFile) return file.path;
    }
    const src = image.getAttribute("src");
    if (!src) return undefined;
    const normalizedSrc = src.split(/[?#]/, 1)[0];
    for (const file of this.app.vault.getFiles()) {
      const resource = this.app.vault.getResourcePath(file).split(/[?#]/, 1)[0];
      if (resource === normalizedSrc) return file.path;
    }
    return undefined;
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

/** Settings and discoverable controls when command search is unavailable. */
class ChemDrawPasteControlTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ChemDrawPastePlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "ChemDraw Paste — Clipboard Probe" });
    containerEl.createEl("p", { text: "Diagnostics are read-only. Import and refresh controls intentionally write ChemDraw assets or preview embeds to the Vault." });
    new Setting(containerEl)
      .setName("ChemDraw asset folder")
      .setDesc("Vault-relative folder for new ChemDraw/YYYY-MM preview/source pairs. Changing this affects new pastes only.")
      .addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.assetFolder).setValue(this.plugin.getAssetFolder()).onChange((value) => void this.plugin.setAssetFolder(value)));
    new Setting(containerEl)
      .setName("Automatic preview refresh")
      .setDesc("Regenerate the paired PNG when a managed source.cdx is saved. Requires the verified local ChemDraw renderer.")
      .addToggle((toggle) => toggle.setValue(this.plugin.getAutoRefresh()).onChange((value) => void this.plugin.setAutoRefresh(value)));
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
      .setDesc("Ctrl+V is intercepted only when the native Windows clipboard cache confirms ChemDraw. A manual import writes a managed preview/source pair.")
      .addButton((button) => button.setButtonText("Import Preview").setWarning().onClick(() => void this.plugin.importClipboardPreview()));
    new Setting(containerEl)
      .setName("Refresh current ChemDraw preview")
      .setDesc("Place the cursor on a managed preview embed, copy the updated drawing in ChemDraw, then refresh only the paired preview. The source.cdx is never modified.")
      .addButton((button) => button.setButtonText("Refresh Preview").onClick(() => void this.plugin.refreshCurrentChemDrawPreview()));
    new Setting(containerEl)
      .setName("Show last diagnostic")
      .setDesc("Reopen the latest in-memory report; no data is saved to disk.")
      .addButton((button) => button.setButtonText("Show Last Diagnostic").onClick(() => this.plugin.showLastDiagnostic()));
  }
}

// Match the direct CommonJS entry shape used by the working desktop-only plugin in this vault.
module.exports = ChemDrawPastePlugin;
