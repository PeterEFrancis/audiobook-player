const examples = [
  ['walden', 'Walden', 'Henry David Thoreau', 'A quieter kind of adventure. A reflection on simple living, solitude, and finding a little more life in the everyday.', 'Nature', 1854],
  ['sea', 'Moby-Dick', 'Herman Melville', 'Call me Ishmael. Set sail on a vast, restless ocean in one of literature’s most enduring adventures.', 'Adventure', 1851],
  ['pride', 'Pride and Prejudice', 'Jane Austen', 'Wit, first impressions, and an unexpected love story in the English countryside.', 'Classics', 1813],
  ['sherlock', 'The Adventures of Sherlock Holmes', 'Arthur Conan Doyle', 'Follow the world’s most observant detective through the gaslit streets of Victorian London.', 'Mystery', 1892]
];
const audioInfo = {walden:[15.72136,697408],sea:[16.66177,738880],pride:[19.07664,845376],sherlock:[13.77088,611392]};
export const demoBooks = examples.map(([slug,title,author,summary,genre,year]) => ({
  id: `demo:${slug}`, ratingKey: slug, serverId: 'demo', libraryId: 'samples', title, author, summary, year,
  cover: `./assets/cover-${slug}.svg`, thumb: '', genres: [genre, 'Public domain'], collections: ['The classics'],
  demo: true, duration: audioInfo[slug][0], tracks: [{id: slug, ratingKey: slug, title: 'Opening passage · narrated sample', index: 1, disc: 1, duration: audioInfo[slug][0], key: `./assets/sample-${slug}.wav`, mime: 'audio/wav', size: audioInfo[slug][1], chapters: []}]
}));
