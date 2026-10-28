import test from 'node:test';
import assert from 'node:assert/strict';
import {bindPortraitMode} from '../js/portrait.js';

function setup({width = 390, height = 844, touch = 5, type = 'portrait-primary', legacy, lock = 'resolve'} = {}) {
  const calls = [], layer = [];
  const win = new EventTarget(), doc = new EventTarget(), guard = new EventTarget();
  const original = {isConnected: true, focused: 0, focus() { this.focused++; doc.activeElement = this; }};
  const orientation = new EventTarget();
  orientation.type = type;
  if (lock !== 'absent') orientation.lock = async value => {
    calls.push(value);
    if (lock === 'reject') throw new Error('Orientation locking unavailable');
  };
  Object.assign(win, {
    screen: {width, height, ...(type === undefined ? {} : {orientation})},
    navigator: {maxTouchPoints: touch, standalone: true},
    matchMedia: () => ({matches: true}),
    innerWidth: width, innerHeight: height, orientation: legacy,
  });
  if (legacy !== undefined) delete win.screen.orientation;
  Object.assign(doc, {activeElement: original, hidden: false, visibilityState: 'visible', fullscreenElement: null});
  Object.assign(guard, {
    open: false,
    showModal() { if (!this.open) { this.open = true; layer.push(this); } doc.activeElement = this; },
    close() { this.open = false; const at = layer.indexOf(this); if (at >= 0) layer.splice(at, 1); },
  });
  const enforce = bindPortraitMode(guard, {win, doc});
  return {win, doc, guard, original, calls, layer, orientation, enforce};
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('unsupported or rejected locks keep a landscape guard above app dialogs and restore focus in portrait', async () => {
  for (const lock of ['absent', 'reject']) {
    const state = setup({width: 844, height: 390, type: 'landscape-primary', lock});
    const {win, guard, original, calls, layer, orientation, enforce} = state;
    await settled();
    assert.equal(guard.open, true);
    if (lock === 'reject') assert.deepEqual(calls, ['portrait-primary']);
    const appModal = {open: true};
    layer.push(appModal);
    enforce();
    assert.equal(layer.at(-1), guard, 'guard is raised above a newly opened modal');
    assert.equal(appModal.open, true, 'the underlying player remains open');
    const cancel = new Event('cancel', {cancelable: true});
    guard.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    orientation.type = 'portrait-primary';
    Object.assign(win.screen, {width: 390, height: 844});
    orientation.dispatchEvent(new Event('change'));
    await settled();
    assert.equal(guard.open, false);
    assert.equal(original.focused, 1);
    assert.equal(appModal.open, true);
  }
});

test('opening the keyboard in physical portrait does not show a landscape guard', async () => {
  const {win, doc, guard} = setup();
  Object.assign(win, {innerWidth: 390, innerHeight: 200});
  win.dispatchEvent(new Event('resize'));
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('pointerup'));
  await settled();
  assert.equal(guard.open, false);
});

test('desktop and tablets are unaffected while legacy iPhone angles control the guard', async () => {
  for (const options of [
    {width: 1920, height: 1080, touch: 0},
    {width: 1024, height: 768, touch: 5},
  ]) {
    const {win, guard, calls} = setup({...options, type: 'landscape-primary'});
    win.dispatchEvent(new Event('resize'));
    await settled();
    assert.equal(guard.open, false);
    assert.deepEqual(calls, []);
  }
  const {win, guard} = setup({legacy: 90});
  assert.equal(guard.open, true);
  win.orientation = 0;
  win.dispatchEvent(new Event('orientationchange'));
  await settled();
  assert.equal(guard.open, false);
});
