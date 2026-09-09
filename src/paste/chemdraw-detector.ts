/** ClipboardEvent-only detection. Unknown clipboard types are never intercepted. */
export function isChemDrawClipboard(event: ClipboardEvent): boolean {
  const values = [
    ...Array.from(event.clipboardData?.types ?? []),
    ...Array.from(event.clipboardData?.items ?? []).map((item) => item.type),
  ];
  return values.some((value) => /chemdraw|chemoffice|cdxml|\bcdx\b|cambridgesoft|perkinelmer/i.test(value));
}
