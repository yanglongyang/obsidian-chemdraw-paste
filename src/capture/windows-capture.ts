import { promises as fs } from "fs";
import { join } from "path";
import { errorSummary } from "../utils/format";

export interface CapturedAsset { path: string; format: string; sizeBytes: number; }
export interface NativeCapture { preview?: CapturedAsset; sources: CapturedAsset[]; }

const SCRIPT = String.raw`
param([string]$OutDir)
$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Drawing; using System.Drawing.Imaging;
public static class CDP {
 [DllImport("user32.dll",SetLastError=true)] public static extern bool OpenClipboard(IntPtr h);
 [DllImport("user32.dll")] public static extern bool CloseClipboard();
 [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint f);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern uint RegisterClipboardFormat(string n);
 [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
 [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
 [DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
 [DllImport("gdi32.dll")] public static extern IntPtr CopyEnhMetaFile(IntPtr h,string f);
 public static byte[] Read(uint f) { var h=GetClipboardData(f); if(h==IntPtr.Zero)return null; var n=(long)GlobalSize(h); if(n<1||n>104857600)return null; var p=GlobalLock(h); if(p==IntPtr.Zero)return null; try { var b=new byte[n]; Marshal.Copy(p,b,0,(int)n); return b; } finally { GlobalUnlock(h); } }
 public static bool Png(string p) { var h=GetClipboardData(14); if(h==IntPtr.Zero)return false; var c=CopyEnhMetaFile(h,null); if(c==IntPtr.Zero)return false; using(var m=new Metafile(c,true)){ var r=m.GetBounds(ref UnsafeUnit); int w=Math.Max(1,Math.Min(4000,(int)Math.Ceiling(r.Width))); int h2=Math.Max(1,Math.Min(4000,(int)Math.Ceiling(r.Height))); using(var b=new Bitmap(w,h2)){ using(var g=Graphics.FromImage(b)){g.Clear(Color.White);g.DrawImage(m,0,0,w,h2);} b.Save(p,ImageFormat.Png); return true; } } }
 static GraphicsUnit UnsafeUnit=GraphicsUnit.Pixel;
}
'@
$items=@(); if(-not [CDP]::OpenClipboard([IntPtr]::Zero)){throw 'OpenClipboard failed'}
try { foreach($x in @(@('ChemDraw Interchange Format','interchange.bin'),@('ChemDraw Structure Data','structure-data.bin'))){$b=[CDP]::Read([CDP]::RegisterClipboardFormat($x[0]));if($null -ne $b){$p=Join-Path $OutDir $x[1];[IO.File]::WriteAllBytes($p,$b);$items += @{format=$x[0];file=$x[1];sizeBytes=$b.Length}}; $png=Join-Path $OutDir 'preview.png';$has=[CDP]::Png($png) } finally {[void][CDP]::CloseClipboard()}
@{sources=$items;preview=if($has){@{format='CF_ENHMETAFILE';file='preview.png';sizeBytes=(Get-Item $png).Length}}else{$null}}|ConvertTo-Json -Compress
`;

export async function captureWindowsClipboard(directory: string): Promise<NativeCapture> {
  const raw = await new Promise<string>((resolve, reject) => {
    const { execFile } = require("child_process") as typeof import("child_process");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT, "-OutDir", directory], { windowsHide: true, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  try {
    const result = JSON.parse(raw) as { sources?: Array<{ format:string; file:string; sizeBytes:number }>; preview?: {format:string; file:string; sizeBytes:number} };
    return { sources: (result.sources ?? []).map((x) => ({ ...x, path: join(directory, x.file) })), preview: result.preview ? { ...result.preview, path: join(directory, result.preview.file) } : undefined };
  } catch (error) { throw new Error(`Capture metadata error: ${errorSummary(error)}`); }
}

export async function readCaptured(path: string): Promise<ArrayBuffer> { const data = await fs.readFile(path); return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); }
