import test from 'node:test';
import assert from 'node:assert/strict';
import { bindBookSheet } from '../js/book-sheet.js';

function setup({mobile = true, book = true} = {}) {
  function target() {
    const listeners = new Map(), captures = new Set();
    return {
      style: {transform: '', transition: '', setProperty(key, value) { this[key] = value; }, removeProperty(key) { this[key] = ''; }},
      addEventListener(type, listener) { (listeners.get(type) || listeners.set(type, []).get(type)).push(listener); },
      setPointerCapture(id) { captures.add(id); },
      releasePointerCapture(id) { captures.delete(id); },
      hasPointerCapture(id) { return captures.has(id); },
      dispatch(type, extra = {}) {
        const event = {type, target: handle, currentTarget: this, pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 0,
          defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra};
        for (const listener of listeners.get(type) || []) listener(event);
        return event;
      },
    };
  }
  const classes = new Set(book ? ['modal', 'book-modal'] : ['modal']);
  const handle = {...target(), closest: selector => selector === '.modal-handle' ? handle : null};
  const modal = {...target(), open: true, closes: 0,
    classList: {contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name)},
    close() { this.closes++; this.open = false; this.dispatch('close'); },
  };
  const reset = bindBookSheet(modal, {isMobile: () => mobile});
  const drag = (x, y) => {
    modal.dispatch('pointerdown');
    modal.dispatch('pointermove', {clientX: x, clientY: y});
    modal.dispatch('pointerup', {clientX: x, clientY: y});
  };
  return {modal, handle, reset, drag};
}

test('a downward handle drag moves and dismisses the mobile book sheet', () => {
  const {modal} = setup();
  modal.dispatch('pointerdown');
  modal.dispatch('pointermove', {clientY: 90});
  assert.ok(modal.style.transform.includes('90'), 'sheet follows the drag');
  modal.dispatch('pointerup', {clientY: 90});
  assert.equal(modal.closes, 1);
  assert.equal(modal.style.transform, '');
});

test('short, upward, and horizontal drags return without closing or becoming clicks', () => {
  for (const [x, y] of [[100, 20], [100, -100], [220, 90]]) {
    const {modal, drag} = setup();
    drag(x, y);
    assert.equal(modal.closes, 0);
    assert.equal(modal.style.transform, '');
    const click = modal.dispatch('click');
    assert.ok(click.defaultPrevented || click.stopped, 'drag must not activate the close button');
  }
  const canceled = setup().modal;
  canceled.dispatch('pointerdown');
  canceled.dispatch('pointermove', {clientY: 90});
  canceled.dispatch('pointercancel');
  const contentClick = canceled.dispatch('click', {target: {closest: () => null}});
  assert.equal(contentClick.defaultPrevented, false, 'a canceled drag must not swallow the next content action');
  assert.equal(contentClick.stopped, undefined);
  const {modal} = setup();
  modal.dispatch('pointerdown');
  modal.dispatch('pointerup');
  const tap = modal.dispatch('click');
  assert.equal(tap.defaultPrevented, false);
  assert.equal(tap.stopped, undefined);
  const keyboard = modal.dispatch('click', {detail: 0});
  assert.equal(keyboard.defaultPrevented, false);
});

test('cancellation, capture loss, reset, and close clear an unfinished drag', () => {
  for (const end of ['pointercancel', 'lostpointercapture', 'reset', 'close']) {
    const {modal, reset} = setup();
    modal.dispatch('pointerdown');
    modal.dispatch('pointermove', {clientY: 90});
    if (end === 'reset') reset();
    else if (end === 'close') modal.close();
    else modal.dispatch(end);
    assert.equal(modal.style.transform, '', end);
    modal.dispatch('pointerup', {clientY: 100});
    assert.equal(modal.closes, end === 'close' ? 1 : 0, end);
  }
});

test('desktop, other modals, content scrolling, and secondary pointers are untouched', () => {
  for (const options of [{mobile: false}, {book: false}]) {
    const {modal, drag} = setup(options);
    drag(100, 100);
    assert.equal(modal.closes, 0);
    assert.equal(modal.style.transform, '');
  }
  for (const extra of [{target: {closest: () => null}}, {isPrimary: false}, {button: 2}]) {
    const {modal} = setup();
    const start = modal.dispatch('pointerdown', extra);
    modal.dispatch('pointermove', {clientY: 100});
    modal.dispatch('pointerup', {clientY: 100});
    assert.equal(modal.closes, 0);
    assert.equal(modal.style.transform, '');
    assert.equal(start.defaultPrevented, false);
  }
});
