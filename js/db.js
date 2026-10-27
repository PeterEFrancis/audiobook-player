const DATABASE = 'folio';
const STORES = ['books', 'progress', 'bookmarks', 'downloads', 'history', 'settings', 'sync'];
let connection;

function openDatabase() {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!request.result.objectStoreNames.contains(name)) {
            request.result.createObjectStore(name, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); connection = null; };
        database.onclose = () => { connection = null; };
        resolve(database);
      };
      request.onerror = () => { connection = null; reject(request.error); };
      request.onblocked = () => {
        connection = null;
        reject(new Error('Close other Folio tabs to finish updating its local library.'));
      };
    });
  }
  return connection;
}

async function transact(store, mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error || request.error);
    transaction.onabort = () => reject(transaction.error || new Error('Local storage transaction was interrupted.'));
  });
}

export const db = {
  get: (store, id) => transact(store, 'readonly', objectStore => objectStore.get(id)),
  put: (store, value) => transact(store, 'readwrite', objectStore => objectStore.put(value)),
  delete: (store, id) => transact(store, 'readwrite', objectStore => objectStore.delete(id)),
  all: store => transact(store, 'readonly', objectStore => objectStore.getAll()),
  clear: store => transact(store, 'readwrite', objectStore => objectStore.clear()),
};
