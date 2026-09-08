/** Conservative labels only. A candidate is not evidence of editable ChemDraw data. */
export function classifyFormat(name: string): string {
  const value = name.toLowerCase();
  if (value.includes("html")) return "HTML";
  if (value.includes("rtf")) return "RTF";
  if (value.includes("text") || value === "cf_unicodeText".toLowerCase() || value === "cf_text") return "Text";
  if (value.includes("hdrop") || value === "files") return "File";
  if (value.includes("enhmetafile") || value.includes("metafile") || value.includes("emf")) return "Metafile";
  if (value.startsWith("image/") || value.includes("cf_dib") || value.includes("bitmap")) return "Image";
  if (value.startsWith("electron application/osclipboard") || value.includes("custom")) return "OS Custom";
  return "Unknown";
}

export function isPotentialChemDrawFormat(name: string): boolean {
  return /(chemdraw|chemoffice|cdxml|\bcdx\b|cambridgesoft|perkinelmer|revvity|object descriptor|embed source|\bnative\b)/i.test(name);
}

export function isPreviewCandidate(name: string): boolean {
  const value = name.toLowerCase();
  return value.startsWith("image/") || value.includes("enhmetafile") || value.includes("metafile") || value.includes("cf_dib") || value.includes("bitmap");
}
