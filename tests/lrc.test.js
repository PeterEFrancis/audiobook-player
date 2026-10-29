import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLRC, cueAt, sentenceCues } from '../js/lrc.js';

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

test('sentence cues join timed rows through abbreviations and retain the sentence start', () => {
  const cues = sentenceCues(parseLRC('[00:01]Mr.\n[00:02]Dursley was perfectly\n[00:04]normal, thank you very much.\n[00:07]“Really?”\n[00:08]Yes. Two sentences in one row.'));
  assert.deepEqual(cues, [
    { start: 1, end: 7, text: 'Mr. Dursley was perfectly normal, thank you very much.' },
    { start: 7, end: 8, text: '“Really?”' },
    { start: 8, end: null, text: 'Yes. Two sentences in one row.' },
  ]);
  assert.equal(cueAt(cues, 5), 0);
  assert.equal(cueAt(cues, 7), 1);
});

test('empty cues bound incomplete sentences and word times survive grouping without mutation', () => {
  const raw = parseLRC('[00:01]<00:01>Hello\n[00:02]<00:02>world!\n[00:03]An unfinished thought\n[00:05]\n[00:07]A new thought…');
  const before = structuredClone(raw);
  const cues = sentenceCues(raw);
  assert.deepEqual(raw, before);
  assert.equal(cues[0].text, 'Hello world!');
  assert.deepEqual(cues[0].words.map(word => word.start), [1, 2]);
  assert.deepEqual(cues.slice(1), [
    { start: 3, end: 5, text: 'An unfinished thought' },
    { start: 5, end: 7, text: '' },
    { start: 7, end: null, text: 'A new thought…' },
  ]);
});
