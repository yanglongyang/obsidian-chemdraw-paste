import { promises as fs } from "fs";
import { join } from "path";

export interface RenderResult {
  backend: string;
  outputPath: string;
  sizeBytes: number;
}

const SCRIPT = String.raw`
param([string]$SourcePath, [string]$OutputPath, [int]$TargetWidth = 0, [int]$TargetHeight = 0)
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
  $targetWidth = if ($TargetWidth -gt 0) { $TargetWidth } else { $bitmapIn.Width }
  $targetHeight = if ($TargetHeight -gt 0) { $TargetHeight } else { $bitmapIn.Height }
  $bitmapOut = [System.Drawing.Bitmap]::new($targetWidth, $targetHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmapOut)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $scale = [Math]::Min($targetWidth / [double]$bitmapIn.Width, $targetHeight / [double]$bitmapIn.Height)
    $drawWidth = [Math]::Max(1, [int][Math]::Round($bitmapIn.Width * $scale))
    $drawHeight = [Math]::Max(1, [int][Math]::Round($bitmapIn.Height * $scale))
    $offsetX = [int][Math]::Floor(($targetWidth - $drawWidth) / 2)
    $offsetY = [int][Math]::Floor(($targetHeight - $drawHeight) / 2)
    $graphics.DrawImage($bitmapIn, $offsetX, $offsetY, $drawWidth, $drawHeight)
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

function getPngDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (!isPng(data) || data.length < 24 || String.fromCharCode(...data.slice(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 ? { width, height } : undefined;
}

export class WindowsChemDrawRenderer {
  async render(sourceAbsolutePath: string, directory: string, target?: { width: number; height: number }): Promise<RenderResult> {
    const scriptPath = join(directory, "render.ps1");
    const outputPath = join(directory, "preview.png");
    await fs.writeFile(scriptPath, SCRIPT, "utf8");
    const raw = await new Promise<string>((resolve, reject) => {
      const { execFile } = require("child_process") as typeof import("child_process");
      const args = ["-NoProfile", "-NonInteractive", "-STA", "-File", scriptPath, "-SourcePath", sourceAbsolutePath, "-OutputPath", outputPath];
      if (target) args.push("-TargetWidth", String(target.width), "-TargetHeight", String(target.height));
      execFile("powershell.exe", args, { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout));
    });
    void raw;
    const data = new Uint8Array(await fs.readFile(outputPath));
    if (data.length < 128 || !isPng(data)) throw new Error("ChemDraw renderer returned an invalid PNG");
    return { backend: "ChemDrawControl_x64.ChemDrawCtl.SaveAs", outputPath, sizeBytes: data.length };
  }
}

export { getPngDimensions, isPng };
