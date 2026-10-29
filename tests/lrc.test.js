import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLRC, cueAt } from '../js/lrc.js';

test('standard LRC sorts repeated timestamps, ignores metadata, and retains end-clearing cues', () => {
  const cues = parseLRC('\uFEFF[ti:Example]\r\n[ar:Author]\r\n[01:00.125][00:03.5]Repeated line\r\n[00:01.00]First line\r\n[00:04.00]\r\n[01:02:03.250]An hour later');
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, text: 'First line' },
    { start: 3.5, end: 4, text: 'Repeated line' },
    { start: 4, end: 60.125, text: '' },
    { start: 60.125, end: 3723.25, text: 'Repeated line' },
    { start: 3723.25, end: null, text: 'An hour later' },
  ]);
  assert.equal(cueAt(cues, 0), -1);
  assert.equal(cueAt(cues, 1), 0);
  assert.equal(cueAt(cues, 3.75), 1);
  assert.equal(cueAt(cues, 4), 2);
  assert.equal(cueAt(cues, 4000), 4);
});

test('positive offset advances the whole file, negative delays, and clamped duplicates use the last cue', () => {
  const cues = parseLRC('[00:00.10]First\n[00:00.20]Second\n[00:02.00]Later\n[offset:+500]');
  assert.deepEqual(cues.map(cue => cue.start), [0, 0, 1.5]);
  assert.equal(cueAt(cues, 0), 1);
  assert.equal(parseLRC('[00:01.00]Text\n[offset:+750]')[0].start, 0.25);
  assert.equal(parseLRC('[00:01.00]Text\n[offset:-750]')[0].start, 1.75);
});

test('enhanced LRC retains word timing and shifts repeated lines and offsets together', () => {
  const cues = parseLRC('[offset:100]\n[00:01.00][00:10.00]<00:01.10>Hello <00:01.50>world<00:01.90>\n[00:12.00]Next');
  assert.equal(cues[0].text, 'Hello world');
  assert.deepEqual(cues[0].words, [
    { start: 1, end: 1.4, text: 'Hello' },
    { start: 1.4, end: 1.8, text: 'world' },
  ]);
  assert.deepEqual(cues[1].words, [
    { start: 10, end: 10.4, text: 'Hello' },
    { start: 10.4, end: 10.8, text: 'world' },
  ]);
});

test('malformed input stays finite and literal text is not interpreted as markup', () => {
  assert.deepEqual(parseLRC(null), []);
  assert.deepEqual(parseLRC('[bad]\n[00:99.00]Bad\n[01:61:00]Bad\nPlain text'), []);
  const cues = parseLRC('[00:01.00]<img src=x onerror=alert(1)> literal <not-a-time>\n[00:02.00]Next');
  assert.equal(cues[0].text, '<img src=x onerror=alert(1)> literal <not-a-time>');
  assert.equal(cues[0].words, undefined);
  assert.equal(cueAt([], 1), -1);
  assert.equal(cueAt(cues, NaN), -1);
});
