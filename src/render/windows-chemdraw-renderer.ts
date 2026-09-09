import { promises as fs } from "fs";
import { join } from "path";

export interface RenderResult {
  backend: string;
  outputPath: string;
  sizeBytes: number;
}

const SCRIPT = String.raw`
param([string]$SourcePath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$control = $null
$rawPath = "$OutputPath.raw.png"
try {
  $control = New-Object -ComObject ChemDrawControl_x64.ChemDrawCtl
  $control.AllowInvisibleView = $true
  if (-not $control.Open($SourcePath, $true)) { throw 'ChemDraw COM control could not open the CDX source' }
  $control.SaveAs($rawPath, 'png', 0, 0, 0)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($control)
  $control = $null
  if (-not (Test-Path -LiteralPath $rawPath -PathType Leaf)) { throw 'ChemDraw COM control did not produce a PNG' }
  Add-Type -AssemblyName System.Drawing
  $bitmapIn = [System.Drawing.Bitmap]::new($rawPath)
  $bitmapOut = [System.Drawing.Bitmap]::new($bitmapIn.Width, $bitmapIn.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmapOut)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.DrawImageUnscaled($bitmapIn, 0, 0)
    $bitmapOut.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose(); $bitmapOut.Dispose(); $bitmapIn.Dispose()
  }
} finally {
  Remove-Item -LiteralPath $rawPath -Force -ErrorAction SilentlyContinue
  # Release the isolated COM control without forcing a process-wide GC wait.
  if ($control) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($control) } catch {} }
  $control = $null
}
`;

function isPng(data: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return data.length > signature.length && signature.every((value, index) => data[index] === value);
}

export class WindowsChemDrawRenderer {
  async render(sourceAbsolutePath: string, directory: string): Promise<RenderResult> {
    const scriptPath = join(directory, "render.ps1");
    const outputPath = join(directory, "preview.png");
    await fs.writeFile(scriptPath, SCRIPT, "utf8");
    const raw = await new Promise<string>((resolve, reject) => {
      const { execFile } = require("child_process") as typeof import("child_process");
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-File", scriptPath, "-SourcePath", sourceAbsolutePath, "-OutputPath", outputPath], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout));
    });
    void raw;
    const data = new Uint8Array(await fs.readFile(outputPath));
    if (data.length < 128 || !isPng(data)) throw new Error("ChemDraw renderer returned an invalid PNG");
    return { backend: "ChemDrawControl_x64.ChemDrawCtl.SaveAs", outputPath, sizeBytes: data.length };
  }
}

export { isPng };
