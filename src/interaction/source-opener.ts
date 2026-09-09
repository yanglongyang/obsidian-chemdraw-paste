import { isAbsolute } from "path";

export type DefaultAppRunner = (absolutePath: string) => Promise<void>;

async function runWindowsDefaultApp(absolutePath: string): Promise<void> {
  const { execFile } = require("child_process") as typeof import("child_process");
  await new Promise<void>((resolve, reject) => {
    // Windows PowerShell supports -FilePath across the versions shipped with
    // Obsidian. The path stays in an environment variable, never in command text.
    const command = "Start-Process -FilePath $env:CHEMDRAW_PASTE_SOURCE -ErrorAction Stop";
    const env = { ...process.env, CHEMDRAW_PASTE_SOURCE: absolutePath };
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10000, env }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}

/** Open a validated source through the Windows default .cdx association. */
export async function openSourceWithDefaultApp(absolutePath: string, runner: DefaultAppRunner = runWindowsDefaultApp): Promise<void> {
  if (process.platform !== "win32") throw new Error("default CDX opening is currently Windows-only");
  if (!isAbsolute(absolutePath)) throw new Error("source path must be absolute");
  try {
    await runner(absolutePath);
  } catch (error) {
    throw new Error(`could not open the CDX source with the default Windows application: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
