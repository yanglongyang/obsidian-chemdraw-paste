import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export interface NativeClipboardState {
  available: boolean;
  sequence: number | null;
  hasChemDraw: boolean;
  formats: string[];
}

export type NativeClipboardStateListener = (state: NativeClipboardState) => void;

const MONITOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class CDClipboardMonitor {
    private const uint WM_CLIPBOARDUPDATE = 0x031D;
    private const int WM_DESTROY = 0x0002;
    private const int HWND_MESSAGE = -3;
    private const uint CS_HREDRAW = 0x0002;
    private const uint CS_VREDRAW = 0x0001;
    private const uint SW_HIDE = 0;
    private static WndProcDelegate _wndProc;

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASS {
        public uint style;
        public WndProcDelegate lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string lpszMenuName;
        public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClass(ref WNDCLASS lpWndClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG message, IntPtr hwnd, uint minFilter, uint maxFilter);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool PostQuitMessage(int exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll")]
    private static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClipboardFormatName(uint format, StringBuilder name, int maxCount);
    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    private static string Escape(string value) {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private static string StandardName(uint format) {
        switch (format) {
            case 1: return "CF_TEXT";
            case 2: return "CF_BITMAP";
            case 3: return "CF_METAFILEPICT";
            case 8: return "CF_DIB";
            case 13: return "CF_UNICODETEXT";
            case 14: return "CF_ENHMETAFILE";
            case 15: return "CF_HDROP";
            case 17: return "CF_DIBV5";
            default: return "";
        }
    }

    private static bool IsChemDraw(string value) {
        string lower = value.ToLowerInvariant();
        return lower.Contains("chemdraw") || lower.Contains("chemoffice") || lower.Contains("cdxml") || lower.Contains("cdx") || lower.Contains("cambridgesoft") || lower.Contains("perkinelmer");
    }

    private static void EmitSnapshot() {
        uint sequence = GetClipboardSequenceNumber();
        if (!OpenClipboard(IntPtr.Zero)) {
            Console.WriteLine("{\"available\":false,\"sequence\":" + sequence.ToString() + ",\"hasChemDraw\":false,\"formats\":[]}");
            Console.Out.Flush();
            return;
        }
        try {
            var formats = new System.Collections.Generic.List<string>();
            bool hasChemDraw = false;
            uint current = 0;
            while (true) {
                current = EnumClipboardFormats(current);
                if (current == 0) break;
                StringBuilder buffer = new StringBuilder(512);
                int length = GetClipboardFormatName(current, buffer, buffer.Capacity);
                string name = length > 0 ? buffer.ToString() : StandardName(current);
                if (String.IsNullOrEmpty(name)) name = "Registered format #" + current.ToString();
                if (formats.Count < 128) formats.Add(name);
                if (IsChemDraw(name)) hasChemDraw = true;
            }
            StringBuilder json = new StringBuilder();
            json.Append("{\"available\":true,\"sequence\":").Append(sequence.ToString());
            json.Append(",\"hasChemDraw\":").Append(hasChemDraw ? "true" : "false");
            json.Append(",\"formats\":[");
            for (int i = 0; i < formats.Count; i++) {
                if (i > 0) json.Append(",");
                json.Append("\"").Append(Escape(formats[i])).Append("\"");
            }
            json.Append("]}");
            Console.WriteLine(json.ToString());
            Console.Out.Flush();
        } finally {
            CloseClipboard();
        }
    }

    private static IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam) {
        if (message == WM_CLIPBOARDUPDATE) {
            EmitSnapshot();
            return IntPtr.Zero;
        }
        if (message == WM_DESTROY) {
            PostQuitMessage(0);
            return IntPtr.Zero;
        }
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    public static int Run() {
        string className = "ChemDrawPasteClipboardMonitor_" + Guid.NewGuid().ToString("N");
        _wndProc = WindowProc;
        WNDCLASS windowClass = new WNDCLASS();
        windowClass.style = CS_HREDRAW | CS_VREDRAW;
        windowClass.lpfnWndProc = _wndProc;
        windowClass.hInstance = GetModuleHandle(null);
        windowClass.lpszClassName = className;
        if (RegisterClass(ref windowClass) == 0) return 2;
        IntPtr hwnd = CreateWindowEx(0, className, "", 0, 0, 0, 0, 0, new IntPtr(HWND_MESSAGE), IntPtr.Zero, windowClass.hInstance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) return 3;
        if (!AddClipboardFormatListener(hwnd)) return 4;
        EmitSnapshot();
        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        RemoveClipboardFormatListener(hwnd);
        return 0;
    }
}
'@
[void][CDClipboardMonitor]::Run()
`;

const unavailableState = (): NativeClipboardState => ({ available: false, sequence: null, hasChemDraw: false, formats: [] });

export function parseNativeClipboardStateLine(line: string): NativeClipboardState | undefined {
  try {
    const value = JSON.parse(line) as Partial<NativeClipboardState>;
    if (typeof value.available !== "boolean" || !Array.isArray(value.formats)) return undefined;
    return {
      available: value.available,
      sequence: typeof value.sequence === "number" ? value.sequence : null,
      hasChemDraw: value.available === true && value.hasChemDraw === true,
      formats: value.formats.filter((item): item is string => typeof item === "string"),
    };
  } catch {
    return undefined;
  }
}

export class NativeClipboardMonitor {
  private state: NativeClipboardState = unavailableState();
  private process?: { stdout: { on(event: string, listener: (chunk: Buffer) => void): void }; on(event: string, listener: (...args: unknown[]) => void): void; kill(signal?: string): void };
  private stage?: string;
  private buffer = "";
  private readonly listeners = new Set<NativeClipboardStateListener>();

  getState(): NativeClipboardState { return this.state; }

  onState(listener: NativeClipboardStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (process.platform !== "win32" || this.process) return;
    try {
      this.stage = await mkdtemp(join(tmpdir(), "chemdraw-monitor-"));
      const scriptPath = join(this.stage, "monitor.ps1");
      await writeFile(scriptPath, MONITOR_SCRIPT, "utf8");
      const { spawn } = require("child_process") as typeof import("child_process");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-File", scriptPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.process = child as unknown as typeof this.process;
      child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
      child.on("error", () => this.markUnavailable());
      child.on("exit", () => this.markUnavailable());
    } catch {
      this.markUnavailable();
    }
  }

  stop(): void {
    const child = this.process;
    this.process = undefined;
    if (child) child.kill();
    this.markUnavailable();
    const stage = this.stage;
    this.stage = undefined;
    if (stage) void rm(stage, { recursive: true, force: true });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      const parsed = parseNativeClipboardStateLine(line);
      if (parsed) this.publish(parsed);
      newline = this.buffer.indexOf("\n");
    }
  }

  private markUnavailable(): void {
    this.buffer = "";
    this.publish(unavailableState());
  }

  private publish(state: NativeClipboardState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
