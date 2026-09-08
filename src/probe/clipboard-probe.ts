import type { FormatObservation, MergedFormat, ProviderProbeResult, ProbeReport, RuntimeInfo } from "../types";
import { classifyFormat, isPotentialChemDrawFormat, isPreviewCandidate } from "./heuristics";

export interface ClipboardProvider {
  probe(): Promise<ProviderProbeResult>;
}

export function mergeProbeResults(results: ProviderProbeResult[]): MergedFormat[] {
  const grouped = new Map<string, FormatObservation[]>();
  for (const result of results) {
    for (const format of result.formats) {
      const key = format.name.toLocaleLowerCase();
      const current = grouped.get(key) ?? [];
      current.push(format);
      grouped.set(key, current);
    }
  }
  return [...grouped.values()]
    .map((observations) => {
      const name = observations[0].name;
      return { name, observations, category: classifyFormat(name), possibleChemDraw: isPotentialChemDrawFormat(name), previewCandidate: isPreviewCandidate(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function runClipboardProbe(runtime: RuntimeInfo, providers: ClipboardProvider[]): Promise<ProbeReport> {
  // allSettled prevents one unavailable API from hiding diagnostics from another provider.
  const settled = await Promise.allSettled(providers.map((provider) => provider.probe()));
  const results: ProviderProbeResult[] = settled.map((entry, index) => entry.status === "fulfilled" ? entry.value : ({
    provider: { name: (["Electron Clipboard", "Paste Event", "Windows Native"] as const)[index] ?? "Electron Clipboard", available: false, capability: "error", error: entry.reason instanceof Error ? entry.reason.message : "Provider failed" },
    formats: [],
  }));
  return { runtime, providers: results.map((result) => result.provider), formats: mergeProbeResults(results), timestamp: new Date() };
}
