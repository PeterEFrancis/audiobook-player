import test from 'node:test';
import assert from 'node:assert/strict';
import {bindPortraitMode} from '../js/portrait.js';

function setup({width = 390, height = 844, touch = 5, standalone = true, lock = 'resolve'} = {}) {
  const calls = [], win = new EventTarget(), doc = new EventTarget();
  const orientation = new EventTarget();
  if (lock !== 'absent') orientation.lock = async value => {
    calls.push(value);
    if (lock === 'reject') throw new Error('Orientation locking unavailable');
  };
  Object.assign(win, {
    screen: {width, height, orientation},
    navigator: {maxTouchPoints: touch, standalone},
    matchMedia: () => ({matches: standalone}),
    alert() { throw new Error('Orientation must not display blocking UI'); },
  });
  Object.assign(doc, {
    hidden: false, visibilityState: 'visible', fullscreenElement: null,
    createElement() { throw new Error('Orientation must not create an overlay'); },
  });
  bindPortraitMode({win, doc});
  return {win, doc, calls};
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('installed phones request portrait and retry on foreground and user interaction', async () => {
  const {win, doc, calls} = setup();
  await settled();
  assert.deepEqual(calls, ['portrait-primary']);
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  await settled();
  assert.equal(calls.length, 1);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  await settled();
  assert.equal(calls.length, 2);
  win.dispatchEvent(new Event('pointerup'));
  await settled();
  assert.deepEqual(calls, ['portrait-primary', 'portrait-primary', 'portrait-primary']);
});

test('missing or rejected native locking stays quiet and does not block interaction', async () => {
  for (const lock of ['absent', 'reject']) {
    const {win, doc, calls} = setup({lock});
    await settled();
    win.dispatchEvent(new Event('pointerup'));
    await settled();
    doc.dispatchEvent(new Event('visibilitychange'));
    await settled();
    assert.equal(calls.length, lock === 'absent' ? 0 : 3);
  }
});

test('desktop, tablet, and ordinary browser sessions do not request orientation locks', async () => {
  for (const options of [
    {width: 1920, height: 1080, touch: 0},
    {width: 1024, height: 768, touch: 5},
    {standalone: false},
  ]) {
    const {win, doc, calls} = setup(options);
    win.dispatchEvent(new Event('pointerup'));
    doc.dispatchEvent(new Event('visibilitychange'));
    await settled();
    assert.deepEqual(calls, []);
  }
});
