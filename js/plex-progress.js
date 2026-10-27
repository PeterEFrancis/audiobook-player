const number = value => Math.max(0, Number(value) || 0);
const order = (a, b) => number(a.disc || 1) - number(b.disc || 1) || number(a.index) - number(b.index) || String(a.ratingKey).localeCompare(String(b.ratingKey), undefined, { numeric: true });

/** Resolve Plex metadata tracks, before or after playable multipart files are loaded. */
export function plexProgress(book, rows) {
  const tracks = rows.map(row => ({ ...row,
    ratingKey: String(row.ratingKey), duration: number(row.duration),
    viewOffset: Math.min(number(row.viewOffset), number(row.duration) || Infinity),
    viewCount: number(row.viewCount), lastViewedAt: number(row.lastViewedAt),
  })).sort(order);
  const duration = tracks.reduce((sum, row) => sum + row.duration, 0) || number(book.duration);
  const updatedAt = Math.max(number(book.lastViewedAt), ...tracks.map(row => row.lastViewedAt)) * 1000;
  const plexFingerprint = JSON.stringify([
    number(book.viewCount), number(book.viewedLeafCount), number(book.leafCount), number(book.lastViewedAt),
    tracks.map(row => [row.ratingKey, row.duration, row.viewOffset, row.viewCount, row.lastViewedAt, number(row.index), number(row.disc)]),
  ]);
  let selected = 0;
  let metadataPosition = 0;
  let completed = false;
  const played = tracks.map((row, index) => ({ row, index })).filter(({ row }) => row.viewOffset > 0 || row.viewCount > 0);
  if (played.length) {
    // A positive offset on the latest track also represents a replay of a finished book.
    const latest = played.sort((a, b) => b.row.lastViewedAt - a.row.lastViewedAt || Number(b.row.viewOffset > 0) - Number(a.row.viewOffset > 0) || b.index - a.index)[0];
    selected = latest.index;
    metadataPosition = latest.row.viewOffset;
    if (!metadataPosition) {
      completed = tracks.every(row => row.viewCount > 0);
      if (completed) { selected = tracks.length - 1; metadataPosition = tracks[selected].duration; }
      else {
        // Plex clears a completed track's offset. Continue at the following track.
        const next = tracks.findIndex((row, index) => index > selected && !row.viewCount);
        selected = next >= 0 ? next : Math.max(0, tracks.findIndex(row => !row.viewCount));
      }
    }
  }
  const trackRatingKey = tracks[selected]?.ratingKey || '';
  const elapsed = completed ? duration : tracks.slice(0, selected).reduce((sum, row) => sum + row.duration, 0) + metadataPosition;
  let trackIndex = selected;
  let position = metadataPosition;
  const parts = book.tracks?.map((track, index) => ({ track, index })).filter(({ track }) => String(track.ratingKey) === trackRatingKey) || [];
  if (parts.length) {
    const part = [...parts].reverse().find(({ track }) => number(track.partOffset) <= metadataPosition) || parts[0];
    trackIndex = part.index;
    position = Math.min(number(part.track.duration) || Infinity, Math.max(0, metadataPosition - number(part.track.partOffset)));
  }
  return { id: book.id, trackRatingKey, metadataPosition, trackIndex, position, elapsed, duration,
    completed, played: completed, viewCount: played.length ? Math.max(number(book.viewCount), ...tracks.map(row => row.viewCount)) : 0,
    plexFingerprint, updatedAt, dirty: false, source: 'plex' };
}
