/** Normalize and validate a user-configured path relative to the vault root. */
export function normalizeChemDrawAssetFolder(input: string): string {
  const value = input.trim().replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) throw new Error("asset folder must be a non-empty Vault-relative path");
  const parts = value.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error("asset folder cannot contain . or .. path segments");
  if (parts.some((part) => part.toLowerCase() === ".obsidian")) throw new Error("asset folder cannot be inside .obsidian");
  return parts.join("/");
}

export function makeChemDrawBundleId(date = new Date(), random = Math.random()): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const suffix = Math.floor(Math.max(0, Math.min(0.999999, random)) * 0x10000).toString(16).padStart(4, "0");
  return `CD-${stamp}-${suffix}`;
}

export function chemDrawMonthFolder(date = new Date()): string {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
}
