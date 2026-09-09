import { normalizeChemDrawAssetFolder } from "../utils/vault-path";

function normalizeVaultPath(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

/** Resolve only the current flat ChemDraw preview/source naming convention. */
export function resolveChemDrawSourcePath(previewPath: string, assetRoot: string): string | null {
  let root: string;
  const normalizedPreview = normalizeVaultPath(previewPath);
  try { root = normalizeChemDrawAssetFolder(assetRoot); } catch { return null; }
  if (!normalizedPreview) return null;
  const rootParts = root.split("/");
  const previewParts = normalizedPreview.split("/");
  if (previewParts.length !== rootParts.length + 2 || !rootParts.every((part, index) => previewParts[index] === part)) return null;
  const month = previewParts[rootParts.length];
  const filename = previewParts[rootParts.length + 1];
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const match = /^(CD-.+)-preview\.png$/.exec(filename);
  if (!match) return null;
  return `${root}/${month}/${match[1]}-source.cdx`;
}
