const CDX_SIGNATURE = new Uint8Array([0x56, 0x6a, 0x43, 0x44, 0x30, 0x31, 0x30, 0x30]);
const CDX_ENDIAN_MARKER = new Uint8Array([0x04, 0x03, 0x02, 0x01]);

/**
 * Conservative validation for a ChemDraw binary interchange document.
 *
 * ChemDraw clipboard CDX files may use non-zero reserved bytes, so this
 * intentionally validates only the stable signature, endian marker, and a
 * minimum document length instead of rejecting otherwise valid documents.
 */
export function isValidCDX(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length <= 28) return false;
  for (let index = 0; index < CDX_SIGNATURE.length; index += 1) {
    if (bytes[index] !== CDX_SIGNATURE[index]) return false;
  }
  for (let index = 0; index < CDX_ENDIAN_MARKER.length; index += 1) {
    if (bytes[8 + index] !== CDX_ENDIAN_MARKER[index]) return false;
  }
  return true;
}
