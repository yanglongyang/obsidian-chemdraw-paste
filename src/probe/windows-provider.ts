import type { ProviderProbeResult } from "../types";
import { errorSummary } from "../utils/format";
import { windowsFormatName } from "./windows-formats";

interface NativeFormat { id: number; name?: string; }
interface NativeResponse { formats?: NativeFormat[]; error?: string; }

// Fixed source: clipboard content is never included in the command, output, logs, or filesystem.
const POWERSHELL_ENUMERATOR = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ClipboardProbeNative {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr hWndNewOwner);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();
  [DllImport("user32.dll", SetLastError=true)] public static extern uint EnumClipboardFormats(uint format);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetClipboardFormatName(uint format, StringBuilder lpszFormatName, int cchMaxCount);
}
'@
$result = [ordered]@{ formats = @(); error = $null }
if (-not [ClipboardProbeNative]::OpenClipboard([IntPtr]::Zero)) {
  $result.error = "OpenClipboard failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
} else {
  try {
    [uint32]$format = 0
    while (($format = [ClipboardProbeNative]::EnumClipboardFormats($format)) -ne 0) {
      $buffer = New-Object Text.StringBuilder 256
      $length = [ClipboardProbeNative]::GetClipboardFormatName($format, $buffer, $buffer.Capacity)
      $result.formats += [ordered]@{ id = [int]$format; name = if ($length -gt 0) { $buffer.ToString() } else { $null } }
    }
  } catch { $result.error = $_.Exception.Message }
  finally { [void][ClipboardProbeNative]::CloseClipboard() }
}
$result | ConvertTo-Json -Compress
`;

export class WindowsClipboardProvider {
  // Do not touch optional Node APIs while Obsidian is loading commands.
  constructor(private readonly platform = typeof process === "undefined" ? "unknown" : process.platform, private readonly execute = runPowerShell) {}

  async probe(): Promise<ProviderProbeResult> {
    if (this.platform !== "win32") return { provider: { name: "Windows Native", available: false, capability: "Windows-only" }, formats: [] };
    try {
      const response = await this.execute();
      if (response.error) return { provider: { name: "Windows Native", available: false, capability: "native enumeration", error: response.error }, formats: [] };
      return {
        provider: { name: "Windows Native", available: true, capability: "OpenClipboard/EnumClipboardFormats" },
        formats: (response.formats ?? []).map((format) => ({ name: windowsFormatName(format.id, format.name), provider: "Windows Native", sizeBytes: null, readable: false, note: "Metadata only; native payload was not read." })),
      };
    } catch (error) {
      return { provider: { name: "Windows Native", available: false, capability: "native error", error: errorSummary(error) }, formats: [] };
    }
  }
}

function runPowerShell(): Promise<NativeResponse> {
  return new Promise((resolve, reject) => {
    // Some Electron renderer configurations do not expose child_process. Loading it
    // lazily keeps the rest of the diagnostics and command registration available.
    const { execFile } = require("child_process") as typeof import("child_process");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_ENUMERATOR], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout) as NativeResponse); } catch { reject(new Error("Windows probe returned invalid metadata.")); }
    });
  });
}
