// IndexedDB storage. Audio is written as ~2 s Blob chunks (browser keeps Blobs on disk),
// then stitched into one WAV Blob on finish. No growing JS arrays.

export interface SavedRecording {
  id: string;
  name: string;
  createdAt: number;
  duration: number; // seconds
  size: number;
  channels: number;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('device-audio-recorder', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('recordings', { keyPath: 'id' });
      req.result.createObjectStore('chunks'); // key: [recId, seq]
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const r = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(r.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export function putChunk(recId: string, seq: number, blob: Blob): Promise<unknown> {
  return run('chunks', 'readwrite', (s) => s.put(blob, [recId, seq]));
}

const range = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

/** Stitch header + chunks into the final WAV and store it; removes the temporary chunks. */
export async function finalizeRecording(
  meta: Omit<SavedRecording, 'blob' | 'size'>,
  header: Uint8Array,
): Promise<SavedRecording> {
  const chunks = await run<Blob[]>('chunks', 'readonly', (s) => s.getAll(range(meta.id)));
  const blob = new Blob([header as BlobPart, ...chunks], { type: 'audio/wav' });
  const rec: SavedRecording = { ...meta, size: blob.size, blob };
  await run('recordings', 'readwrite', (s) => s.put(rec));
  await run('chunks', 'readwrite', (s) => s.delete(range(meta.id)));
  return rec;
}

export async function listRecordings(): Promise<SavedRecording[]> {
  const all = await run<SavedRecording[]>('recordings', 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteRecording(id: string): Promise<unknown> {
  return run('recordings', 'readwrite', (s) => s.delete(id));
}

export async function discardChunks(id: string): Promise<void> {
  await run('chunks', 'readwrite', (s) => s.delete(range(id))).catch(() => {});
}
