export function bindPortraitMode({win = window, doc = document} = {}) {
  let locking = false;
  async function lock() {
    const phone = win.navigator.maxTouchPoints > 0 && Math.min(win.screen.width, win.screen.height) > 0 && Math.min(win.screen.width, win.screen.height) <= 600;
    if (!phone || locking || !win.screen.orientation?.lock || !(win.navigator.standalone || win.matchMedia('(display-mode: standalone)').matches || doc.fullscreenElement)) return;
    locking = true;
    try { await win.screen.orientation.lock('portrait-primary'); }
    catch { /* Unsupported browsers keep their normal behavior without showing a prompt. */ }
    finally { locking = false; }
  }
  const update = () => { void lock(); };
  for (const event of ['resize', 'orientationchange', 'pageshow']) win.addEventListener(event, update);
  win.screen.orientation?.addEventListener?.('change', update);
  win.addEventListener('pointerup', update, {once: true});
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) update(); });
  update();
  return update;
}
