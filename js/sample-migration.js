const LEGACY_SAMPLE_IDS = [
  'demo:walden', 'demo:sea', 'demo:pride', 'demo:sherlock',
  'demo:librivox:walden_librivox',
  'demo:librivox:moby_dick_librivox',
  'demo:librivox:pride_prejudice_krs_librivox',
  'demo:librivox:adventuressherlockholmes_v4_1501_librivox',
];

export async function removeLegacySamples(db, downloads) {
  for (const id of LEGACY_SAMPLE_IDS) {
    const [book, download] = await Promise.all([db.get('books', id), db.get('downloads', id)]);
    if (book && (book.serverId !== 'demo' || !book.demo)) continue;
    if (download) await downloads.remove(id);
    if (book?.serverId === 'demo' && book.demo) await db.delete('books', id);
  }
}
