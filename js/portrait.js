export function bindPortraitMode(guard, {win = window, doc = document} = {}) {
  let previousFocus, locking = false;
  const phone = () => win.navigator.maxTouchPoints > 0 && Math.min(win.screen.width, win.screen.height) > 0 && Math.min(win.screen.width, win.screen.height) <= 600;
  function landscape() {
    const type = win.screen.orientation?.type;
    if (type?.startsWith('portrait')) return false;
    if (type?.startsWith('landscape')) return true;
    if (Number.isFinite(win.orientation)) return Math.abs(win.orientation) % 180 === 90;
    return win.screen.width > win.screen.height;
  }
  function sync(raise = false) {
    if (phone() && landscape()) {
      if (!guard.open) {
        previousFocus = doc.activeElement;
        guard.showModal();
      } else if (raise) {
        guard.close();
        guard.showModal();
      }
    } else if (guard.open) {
      guard.close();
      if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
      previousFocus = null;
    }
  }
  async function lock() {
    if (!phone() || locking || !win.screen.orientation?.lock || !(win.navigator.standalone || win.matchMedia('(display-mode: standalone)').matches || doc.fullscreenElement)) return;
    locking = true;
    try { await win.screen.orientation.lock('portrait-primary'); }
    catch { /* The native dialog is the fallback when orientation locking is unavailable. */ }
    finally { locking = false; sync(); }
  }
  const update = () => { sync(); void lock(); };
  guard.addEventListener('cancel', event => { event.preventDefault(); });
  for (const event of ['resize', 'orientationchange', 'pageshow']) win.addEventListener(event, update);
  win.screen.orientation?.addEventListener?.('change', update);
  win.addEventListener('pointerup', () => { void lock(); }, {once: true});
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) update(); });
  update();
  // Opening another native dialog can place it above the guard in the top layer.
  return () => sync(true);
}
