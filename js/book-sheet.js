// Only the handle owns the gesture; the book and chapter list keep native scrolling.
export function bindBookSheet(modal, {isMobile = () => matchMedia('(max-width: 899px)').matches} = {}) {
  let drag, suppressClick = false;
  function reset() {
    const current = drag;
    drag = null;
    modal.classList.remove('is-dragging');
    modal.style.removeProperty('transform');
    if (current?.handle.hasPointerCapture(current.id)) current.handle.releasePointerCapture(current.id);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (!isMobile()) { reset(); return; }
    const x = event.clientX - drag.x, y = event.clientY - drag.y;
    drag.moved ||= Math.hypot(x, y) > 6;
    drag.distance = y > Math.abs(x) ? y : 0;
    modal.style.transform = `translateY(${drag.distance}px)`;
    event.preventDefault();
  }
  modal.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.modal-handle');
    if (!handle || !modal.open || !modal.classList.contains('book-modal') || !isMobile() || event.isPrimary === false || event.button !== 0 || drag) return;
    suppressClick = false;
    drag = {handle, id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, moved: false};
    modal.classList.add('is-dragging');
    handle.setPointerCapture(event.pointerId);
  });
  modal.addEventListener('pointermove', move);
  modal.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    move(event);
    if (!drag) return;
    const dismiss = drag.distance >= 72;
    suppressClick = drag.moved;
    reset();
    if (dismiss) modal.close();
  });
  for (const type of ['pointercancel', 'lostpointercapture']) modal.addEventListener(type, event => {
    if (drag?.id === event.pointerId) { suppressClick = drag.moved; reset(); }
  });
  modal.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0 && event.target.closest('.modal-handle')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    suppressClick = false;
  }, true);
  modal.addEventListener('close', reset);
  return reset;
}
