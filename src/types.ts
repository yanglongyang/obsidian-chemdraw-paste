export type ProviderName = "Electron Clipboard" | "Paste Event" | "Windows Native";

export interface RuntimeInfo {
  platform: string;
  arch: string;
  obsidianVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
}

export interface ProviderStatus {
  name: ProviderName;
  available: boolean;
  capability: string;
  error?: string;
}

export interface FormatObservation {
  name: string;
  provider: ProviderName;
  sizeBytes: number | null;
  readable: boolean;
  error?: string;
  note?: string;
}

export interface ProviderProbeResult {
  provider: ProviderStatus;
  formats: FormatObservation[];
}

export interface MergedFormat {
  name: string;
  observations: FormatObservation[];
  category: string;
  possibleChemDraw: boolean;
  previewCandidate: boolean;
}

export interface ProbeReport {
  runtime: RuntimeInfo;
  providers: ProviderStatus[];
  formats: MergedFormat[];
  timestamp: Date;
}
