import test from 'node:test';
import assert from 'node:assert/strict';
import { plexProgress } from '../js/plex-progress.js';

const book = { id: 'server:book', ratingKey: 'book', duration: 300, leafCount: 3 };
const rows = [1, 2, 3].map(index => ({ ratingKey: String(index), duration: 100, index, disc: 1, viewOffset: 0, viewCount: 0, lastViewedAt: 0 }));
const withRows = values => rows.map((row, index) => ({ ...row, ...values[index] }));

test('initial library progress uses metadata tracks before playable files are loaded', () => {
  const result = plexProgress(book, withRows([{ viewCount: 1, lastViewedAt: 10 }, { viewOffset: 35, lastViewedAt: 20 }]));
  assert.equal(result.trackRatingKey, '2');
  assert.equal(result.trackIndex, 1);
  assert.equal(result.position, 35);
  assert.equal(result.elapsed, 135);
  assert.equal(result.duration, 300);
  assert.equal(result.updatedAt, 20000);
  assert.equal(result.completed, false);
  assert.equal(result.dirty, false);
  assert.equal(result.source, 'plex');
});

test('cleared offsets on completed tracks resume at the next unplayed track', () => {
  const result = plexProgress(book, withRows([{ viewCount: 1, lastViewedAt: 10 }, { viewCount: 1, lastViewedAt: 20 }]));
  assert.equal(result.trackRatingKey, '3');
  assert.equal(result.position, 0);
  assert.equal(result.elapsed, 200);
  assert.equal(result.completed, false);
});

test('a partial track reset overrides stale album completion flags', () => {
  const result = plexProgress({ ...book, viewCount: 1, viewedLeafCount: 3 }, withRows([
    { viewCount: 1, lastViewedAt: 10 }, { viewCount: 1, lastViewedAt: 20 },
  ]));
  assert.equal(result.completed, false);
  assert.equal(result.trackRatingKey, '3');
  assert.equal(result.elapsed, 200);
});

test('finished albums are completed, but a newer replay offset resumes playback', () => {
  const finished = withRows(rows.map((_, index) => ({ viewCount: 1, lastViewedAt: 10 + index })));
  const result = plexProgress({ ...book, viewedLeafCount: 3 }, finished);
  assert.equal(result.completed, true);
  assert.equal(result.played, true);
  assert.equal(result.elapsed, 300);
  assert.equal(result.metadataPosition, 100);
  const replay = plexProgress({ ...book, viewedLeafCount: 3 }, finished.map((row, index) => index === 0 ? { ...row, viewOffset: 25, lastViewedAt: 50 } : row));
  assert.equal(replay.completed, false);
  assert.equal(replay.elapsed, 25);
  assert.equal(replay.trackRatingKey, '1');
});

test('mark unplayed produces a zero checkpoint and changes fingerprint without timestamp changes', () => {
  const old = withRows(rows.map(() => ({ viewCount: 1, lastViewedAt: 20 })));
  const resetRows = old.map(row => ({ ...row, viewCount: 0 }));
  const result = plexProgress({ ...book, viewCount: 1, viewedLeafCount: 3 }, resetRows);
  assert.equal(result.completed, false);
  assert.equal(result.played, false);
  assert.equal(result.viewCount, 0);
  assert.equal(result.elapsed, 0);
  assert.equal(result.trackIndex, 0);
  assert.equal(result.updatedAt, 20000);
  assert.notEqual(result.plexFingerprint, plexProgress(book, old).plexFingerprint);
});

test('latest viewed metadata track takes precedence over an older positive offset', () => {
  const result = plexProgress(book, withRows([{ viewOffset: 90, lastViewedAt: 10 }, { viewOffset: 15, lastViewedAt: 20 }]));
  assert.equal(result.elapsed, 115);
  assert.equal(result.trackRatingKey, '2');
});

test('metadata offsets map into multipart files without counting duplicated part progress', () => {
  const parts = [{ ratingKey: '1', partOffset: 0, duration: 60 }, { ratingKey: '1', partOffset: 60, duration: 40 }, { ratingKey: '2', partOffset: 0, duration: 100 }];
  const result = plexProgress({ ...book, tracks: parts }, withRows([{ viewOffset: 75, lastViewedAt: 10 }]));
  assert.equal(result.trackIndex, 1);
  assert.equal(result.metadataPosition, 75);
  assert.equal(result.position, 15);
  assert.equal(result.elapsed, 75);
  const boundary = plexProgress({ ...book, tracks: parts }, withRows([{ viewOffset: 60, lastViewedAt: 10 }]));
  assert.equal(boundary.trackIndex, 1);
  assert.equal(boundary.position, 0);
});
