import type { RuntimeInfo } from "../types";

interface ProcessLike {
  platform?: string;
  arch?: string;
  resourcesPath?: string;
  versions?: Record<string, string | undefined>;
}

type AppLike = Record<string, unknown>;

/**
 * Obsidian does not expose its own version on every App shape. As a read-only
 * fallback, inspect the installed application's static package metadata; this
 * never touches the vault or clipboard and is guarded for restricted runtimes.
 */
export function getObsidianVersion(app: unknown, processLike: ProcessLike = process): string {
  const record = (app ?? {}) as AppLike;
  for (const candidate of [record.version, record.appVersion, (globalThis as AppLike).appVersion]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  try {
    if (!processLike.resourcesPath) return "unknown";
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const packageJson = fs.readFileSync(path.join(processLike.resourcesPath, "app.asar", "package.json"), "utf8");
    const version = (JSON.parse(packageJson) as { version?: unknown }).version;
    return typeof version === "string" && version.trim() ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export function getRuntimeInfo(appVersion: string, processLike: ProcessLike = process): RuntimeInfo {
  const versions = processLike.versions ?? {};
  return {
    platform: processLike.platform ?? "unknown",
    arch: processLike.arch ?? "unknown",
    obsidianVersion: appVersion || "unknown",
    electronVersion: versions.electron ?? "unknown",
    chromeVersion: versions.chrome ?? "unknown",
    nodeVersion: versions.node ?? "unknown",
  };
}
