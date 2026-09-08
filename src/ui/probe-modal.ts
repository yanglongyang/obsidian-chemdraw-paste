import { App, Modal } from "obsidian";
import type { MergedFormat, ProbeReport, ProviderStatus } from "../types";
import { formatBytes } from "../utils/format";

export class ClipboardProbeModal extends Modal {
  constructor(app: App, private readonly report: ProbeReport) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("chemdraw-paste-modal");
    contentEl.createEl("h2", { text: "ChemDraw Clipboard Probe" });
    contentEl.createEl("p", { text: "Read-only diagnostic metadata. Clipboard payload content is never displayed or saved.", cls: "chemdraw-paste-muted" });
    this.section("Runtime", [
      ["Platform", `${this.report.runtime.platform} ${this.report.runtime.arch}`],
      ["Obsidian", this.report.runtime.obsidianVersion],
      ["Electron", this.report.runtime.electronVersion],
      ["Chrome", this.report.runtime.chromeVersion],
      ["Node", this.report.runtime.nodeVersion],
    ]);
    this.providers();
    this.formats();
    const chem = this.report.formats.filter((format) => format.possibleChemDraw).length;
    const previews = this.report.formats.filter((format) => format.previewCandidate).length;
    this.section("Summary", [["Total formats", String(this.report.formats.length)], ["Potential ChemDraw / OLE candidates", String(chem)], ["Preview candidates", String(previews)]]);
  }

  private section(title: string, rows: Array<[string, string]>): void {
    this.contentEl.createEl("h3", { text: title });
    const list = this.contentEl.createDiv({ cls: "chemdraw-paste-key-values" });
    for (const [label, value] of rows) {
      list.createEl("span", { text: label, cls: "chemdraw-paste-label" });
      list.createEl("code", { text: value });
    }
  }

  private providers(): void {
    this.contentEl.createEl("h3", { text: "Providers" });
    const list = this.contentEl.createDiv({ cls: "chemdraw-paste-providers" });
    for (const provider of this.report.providers) this.providerRow(list, provider);
  }

  private providerRow(parent: HTMLElement, provider: ProviderStatus): void {
    const row = parent.createDiv({ cls: "chemdraw-paste-provider" });
    row.createEl("strong", { text: provider.name });
    row.createEl("span", { text: provider.available ? "Available" : "Unavailable", cls: provider.available ? "chemdraw-paste-ok" : "chemdraw-paste-error" });
    row.createEl("code", { text: provider.capability });
    if (provider.error) row.createEl("div", { text: provider.error, cls: "chemdraw-paste-error" });
  }

  private formats(): void {
    this.contentEl.createEl("h3", { text: "Detected clipboard representations" });
    if (this.report.formats.length === 0) {
      this.contentEl.createEl("p", { text: "没有检测到可读取的剪贴板格式。请先在 ChemDraw 中复制一个结构或反应路线，再重新检查。", cls: "chemdraw-paste-muted" });
      return;
    }
    const table = this.contentEl.createEl("table", { cls: "chemdraw-paste-table" });
    const header = table.createEl("thead").createEl("tr");
    for (const label of ["Format", "Size", "Category", "Observed by", "Readability", "Notes"]) header.createEl("th", { text: label });
    const body = table.createEl("tbody");
    for (const format of this.report.formats) this.formatRow(body, format);
  }

  private formatRow(body: HTMLTableSectionElement, format: MergedFormat): void {
    const row = body.createEl("tr");
    const name = row.createEl("td");
    name.createEl("code", { text: format.name });
    if (format.possibleChemDraw) name.createEl("div", { text: "可能与 ChemDraw / OLE 相关（启发式）", cls: "chemdraw-paste-candidate" });
    const knownSizes = format.observations.map((item) => item.sizeBytes).filter((size): size is number => size !== null);
    row.createEl("td", { text: knownSizes.length ? formatBytes(Math.max(...knownSizes)) : "unknown" });
    row.createEl("td", { text: format.category });
    row.createEl("td", { text: [...new Set(format.observations.map((item) => item.provider))].join(", ") });
    row.createEl("td", { text: format.observations.some((item) => item.readable) ? "readable" : "metadata only / unreadable" });
    row.createEl("td", { text: format.observations.map((item) => item.error ?? item.note).filter(Boolean).join("; ") || "—" });
  }

  onClose(): void { this.contentEl.empty(); }
}
