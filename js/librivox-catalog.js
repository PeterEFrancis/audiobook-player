// Retire metadata from the former automatic import while keeping chosen books.
export async function retireAutomaticCatalog(db) {
  const migrationId = 'librivox-selection-migration';
  if ((await db.get('settings', migrationId))?.complete) return;
  const [books, downloads, progress, bookmarks, history, preferences] = await Promise.all([
    db.all('books'), db.all('downloads'), db.all('progress'), db.all('bookmarks'), db.all('history'), db.get('settings', 'preferences'),
  ]);
  const retained = new Set([
    ...downloads.map(row => row.id),
    ...progress.filter(row => row.elapsed > 0 || row.completed).map(row => row.id),
    ...bookmarks.map(row => row.bookId),
    ...history.filter(row => row.listened > 0).map(row => row.bookId),
    ...(preferences?.reading || []), ...(preferences?.queue || []),
  ]);
  for (const book of books) {
    if (book.serverId !== 'librivox' && !book.librivox) continue;
    if (book.inLibrary || retained.has(book.id)) {
      if (!book.inLibrary) await db.put('books', {...book, inLibrary: true});
    } else await db.delete('books', book.id);
  }
  await db.delete('settings', 'librivox-catalog');
  await db.put('settings', {id: migrationId, complete: true});
}
