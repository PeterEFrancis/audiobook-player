export const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const clock = (s = 0) => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const duration = (s = 0) => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)} min` : `${Math.round(s)} sec`;
export const bytes = (n = 0) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
export const sumDuration = book => (book.tracks || []).reduce((sum, t) => sum + (t.duration || 0), 0) || book.duration || 0;
export const absolutePosition = (book, index, position) => (book.tracks || []).slice(0, index).reduce((sum, t) => sum + (t.duration || 0), 0) + (position || 0);
export function locatePosition(book, seconds) {
  const tracks = book.tracks || [];
  let left = Math.max(0, seconds);
  for (let i = 0; i < tracks.length; i++) {
    if (left < tracks[i].duration || i === tracks.length - 1) return {index: i, position: Math.min(left, Math.max(0, tracks[i].duration - 0.05))};
    left -= tracks[i].duration;
  }
  return {index: 0, position: 0};
}
export function chaptersFor(book) {
  let offset = 0;
  return (book.tracks || []).flatMap((track, index) => {
    const chapters = track.chapters?.length ? track.chapters : [{title: track.title || `Track ${index + 1}`, start: 0, end: track.duration}];
    const result = chapters.map((c, n) => ({...c, id: `${track.id}:${n}`, index, title: c.title || `Chapter ${n + 1}`, position: c.start || 0, absolute: offset + (c.start || 0), duration: Math.max(0, (c.end || track.duration) - (c.start || 0))}));
    offset += track.duration || 0;
    return result;
  });
}
