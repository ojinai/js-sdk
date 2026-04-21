/** Convert a UUID string to 16 bytes. */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Convert 16 bytes to a UUID string. */
export function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  const h = hex.join("");
  return [
    h.substring(0, 8),
    h.substring(8, 12),
    h.substring(12, 16),
    h.substring(16, 20),
    h.substring(20, 32),
  ].join("-");
}

/** Nil UUID (all zeros) used for idle frames. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
