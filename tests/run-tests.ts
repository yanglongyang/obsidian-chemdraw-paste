import assert from "node:assert/strict";
import { runClipboardProbe, mergeProbeResults } from "../src/probe/clipboard-probe";
import { classifyFormat, isPotentialChemDrawFormat, isPreviewCandidate } from "../src/probe/heuristics";
import { PasteEventProvider } from "../src/probe/paste-event-provider";
import { windowsFormatName } from "../src/probe/windows-formats";
import { formatBytes } from "../src/utils/format";
import { getObsidianVersion, getRuntimeInfo } from "../src/utils/runtime";
import { isChemDrawClipboard } from "../src/paste/chemdraw-detector";
import { parseNativeClipboardStateLine } from "../src/capture/windows-clipboard-monitor";
import { isValidCDX } from "../src/capture/cdx";

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("formatBytes formats known and unknown byte counts", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(128), "128 B");
  assert.equal(formatBytes(4301), "4.2 KB");
  assert.equal(formatBytes(1782579), "1.7 MB");
  assert.equal(formatBytes(null), "unknown");
});

test("classification and conservative candidates", () => {
  assert.equal(classifyFormat("text/plain"), "Text");
  assert.equal(classifyFormat("image/png"), "Image");
  assert.equal(classifyFormat("CF_ENHMETAFILE"), "Metafile");
  assert.equal(isPotentialChemDrawFormat("ChemDraw CDX"), true);
  assert.equal(isPotentialChemDrawFormat("Object Descriptor"), true);
  assert.equal(isPotentialChemDrawFormat("image/png"), false);
  assert.equal(isPreviewCandidate("image/png"), true);
  assert.equal(isPreviewCandidate("CF_ENHMETAFILE"), true);
  assert.equal(isPreviewCandidate("text/plain"), false);
});

test("smart paste detection is conservative", () => {
  const event = (types: string[]) => ({ clipboardData: { types, items: types.map((type) => ({ type })) } }) as unknown as ClipboardEvent;
  assert.equal(isChemDrawClipboard(event(["text/plain", "text/html"])), false);
  assert.equal(isChemDrawClipboard(event(["ChemDraw Interchange Format"])), true);
  assert.equal(isChemDrawClipboard(event(["application/x-cdxml"])), true);
});

test("native monitor parser preserves true and false clipboard states", () => {
  const chemDraw = parseNativeClipboardStateLine('{"available":true,"sequence":42,"hasChemDraw":true,"formats":["ChemDraw Interchange Format","CF_ENHMETAFILE"]}');
  assert.deepEqual(chemDraw, { available: true, sequence: 42, hasChemDraw: true, formats: ["ChemDraw Interchange Format", "CF_ENHMETAFILE"] });
  const plain = parseNativeClipboardStateLine('{"available":true,"sequence":43,"hasChemDraw":false,"formats":["CF_UNICODETEXT"]}');
  assert.equal(plain?.hasChemDraw, false);
  const unavailable = parseNativeClipboardStateLine('{"available":false,"sequence":43,"hasChemDraw":true,"formats":[]}');
  assert.equal(unavailable?.hasChemDraw, false);
  assert.equal(parseNativeClipboardStateLine("not json"), undefined);
});

test("CDX validator accepts the ChemDraw signature without reserved-byte assumptions", () => {
  const bytes = new Uint8Array(32);
  bytes.set([0x56, 0x6a, 0x43, 0x44, 0x30, 0x31, 0x30, 0x30, 0x04, 0x03, 0x02, 0x01, 0x80]);
  assert.equal(isValidCDX(bytes), true);
  assert.equal(isValidCDX(bytes.slice(0, 28)), false);
  bytes[0] = 0;
  assert.equal(isValidCDX(bytes), false);
});

test("merge retains every provider observation", () => {
  const formats = mergeProbeResults([
    { provider: { name: "Electron Clipboard", available: true, capability: "test" }, formats: [{ name: "Custom-A", provider: "Electron Clipboard", sizeBytes: 10, readable: true }] },
    { provider: { name: "Windows Native", available: true, capability: "test" }, formats: [{ name: "Custom-A", provider: "Windows Native", sizeBytes: null, readable: false }, { name: "CF_ENHMETAFILE", provider: "Windows Native", sizeBytes: null, readable: false }] },
  ]);
  const custom = formats.find((format) => format.name === "Custom-A");
  assert.equal(custom?.observations.length, 2);
  assert.deepEqual(custom?.observations.map((item) => item.provider), ["Electron Clipboard", "Windows Native"]);
});

test("runtime metadata falls back safely", () => {
  const runtime = getRuntimeInfo("", { platform: "win32", arch: "x64", versions: {} });
  assert.equal(runtime.obsidianVersion, "unknown");
  assert.equal(runtime.electronVersion, "unknown");
  assert.equal(runtime.nodeVersion, "unknown");
});

test("Obsidian version accepts direct app metadata and safely falls back", () => {
  assert.equal(getObsidianVersion({ appVersion: "1.13.7" }, { versions: {} }), "1.13.7");
  assert.equal(getObsidianVersion({}, { versions: {} }), "unknown");
});

test("Windows standard and registered names are mapped", () => {
  assert.equal(windowsFormatName(13), "CF_UNICODETEXT");
  assert.equal(windowsFormatName(14), "CF_ENHMETAFILE");
  assert.equal(windowsFormatName(49152, "ChemDraw Format"), "ChemDraw Format");
  assert.equal(windowsFormatName(49153), "Registered format #49153");
});

test("a provider failure does not fail the whole report", async () => {
  const report = await runClipboardProbe(
    { platform: "win32", arch: "x64", obsidianVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: "test" },
    [
      { probe: async () => { throw new Error("clipboard unavailable"); } },
      { probe: async () => ({ provider: { name: "Paste Event" as const, available: true, capability: "test" }, formats: [{ name: "text/plain", provider: "Paste Event" as const, sizeBytes: null, readable: false }] }) },
    ],
  );
  assert.equal(report.providers[0].available, false);
  assert.equal(report.formats.length, 1);
});

test("paste probe is one-shot and cleans itself up", () => {
  let listener: ((event: ClipboardEvent) => void) | undefined;
  const fakeWindow = {
    addEventListener: (_type: string, callback: (event: ClipboardEvent) => void) => { listener = callback; },
    removeEventListener: () => { listener = undefined; },
    setTimeout: (callback: () => void) => { callback(); return 0; },
  };
  (globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;
  const probe = new PasteEventProvider();
  let captured = false;
  probe.arm(() => { captured = true; });
  assert.equal(probe.getState(), "armed");
  listener?.({ clipboardData: { types: ["text/plain"], files: { length: 0 } } } as unknown as ClipboardEvent);
  assert.equal(probe.getState(), "idle");
  assert.equal(captured, true);
});

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (error) { failed += 1; console.error(`✗ ${name}`, error); }
  }
  if (failed) process.exitCode = 1;
}

void main();
