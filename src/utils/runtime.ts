import type { RuntimeInfo } from "../types";

interface ProcessLike {
  platform?: string;
  arch?: string;
  versions?: Record<string, string | undefined>;
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
