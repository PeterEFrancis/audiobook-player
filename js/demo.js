import { sampleAudio } from './sample-audio.js';

const examples = [
  ['walden', 'Walden', 'Henry David Thoreau', 'A quieter kind of adventure. A reflection on simple living, solitude, and finding a little more life in the everyday.', 'Nature', 1854],
  ['sea', 'Moby-Dick', 'Herman Melville', 'Call me Ishmael. Set sail on a vast, restless ocean in one of literature’s most enduring adventures.', 'Adventure', 1851],
  ['pride', 'Pride and Prejudice', 'Jane Austen', 'Wit, first impressions, and an unexpected love story in the English countryside.', 'Classics', 1813],
  ['sherlock', 'The Adventures of Sherlock Holmes', 'Arthur Conan Doyle', 'Follow the world’s most observant detective through the gaslit streets of Victorian London.', 'Mystery', 1892]
];
export const demoBooks = examples.map(([slug,title,author,summary,genre,year]) => {
  const source = sampleAudio[slug];
  return {
    id: `demo:librivox:${source.identifier}`, ratingKey: slug, serverId: 'demo', libraryId: 'samples',
    title, author, summary, year, narrator: source.narrator, sourceURL: source.sourceURL,
    archiveURL: source.archiveURL, recordingYear: source.recordingYear, license: source.license,
    cover: `./assets/cover-${slug}.svg`, thumb: '', genres: [genre, 'Public domain'], collections: ['Free audiobooks'],
    demo: true, duration: source.files.reduce((sum, file) => sum + file.duration, 0),
    tracks: source.files.map((file,index) => ({
      id: `${source.identifier}:${index+1}`, ratingKey: `${slug}:${index+1}`, title: file.title,
      index: index+1, disc: 1, duration: file.duration, key: file.url, mime: 'audio/mpeg', size: file.size, chapters: [],
    })),
  };
});
