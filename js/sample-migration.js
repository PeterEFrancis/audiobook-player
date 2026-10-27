const LEGACY_SAMPLE_IDS = ['demo:walden', 'demo:sea', 'demo:pride', 'demo:sherlock'];

export async function removeLegacySamples(db, downloads) {
  for (const id of LEGACY_SAMPLE_IDS) {
    const [book, download] = await Promise.all([db.get('books', id), db.get('downloads', id)]);
    if (download) await downloads.remove(id);
    if (book?.serverId === 'demo' && book.demo) await db.delete('books', id);
  }
}
