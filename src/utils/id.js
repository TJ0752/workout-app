/**
 * crypto.randomUUID() requires a secure context and a fairly recent
 * Chromium (92+) - some Android WebView builds, particularly system images
 * that don't get Play Store WebView auto-updates, predate that and throw
 * "crypto.randomUUID is not a function", which crashes routine/task
 * creation outright (caught via a real device/emulator, not visible in a
 * desktop browser). Falls back to crypto.getRandomValues() (supported since
 * Android 4.4) and finally Math.random so id generation can never hard-crash.
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    return (
      `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-` +
      `${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
    );
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
