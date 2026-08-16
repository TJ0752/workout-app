/** A short, synthesized "ding" via the Web Audio API - no bundled audio asset needed, matching
 * this codebase's general preference for built-in platform capabilities over new dependencies
 * (see the icon-glyph precedent in CLAUDE.md). Best-effort: silently no-ops if AudioContext isn't
 * available or a browser autoplay/gesture policy blocks it, since a missed beep shouldn't break
 * the timer itself - the visual ring/number already communicate the same moment.
 */
export function playBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    osc.onended = () => ctx.close();
  } catch {
    // Best-effort only - see file header.
  }
}
