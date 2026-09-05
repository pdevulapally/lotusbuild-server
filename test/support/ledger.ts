import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
type Data = Record<string, unknown>;
export function ledger() {
  const data = new Map<string, Data>();
  let sequence = 0;
  let tail = Promise.resolve();
  const snapshot = (ref: { path: string; id: string }, source = data) => ({ ref, id: ref.id, exists: source.has(ref.path), data: () => source.get(ref.path) });
  const doc = (path: string) => ({ path, id: path.split('/').at(-1)!, get: async () => snapshot(doc(path)),
    delete: async () => { data.delete(path); },
    update: async (fields: Data) => { const old = data.get(path); if (!old) throw new Error('Document missing'); const next = { ...old, ...fields }; for (const [key, value] of Object.entries(next)) if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete next[key]; data.set(path, next); },
    collection: (name: string) => collection(`${path}/${name}`) });
  const collection = (path: string, filters: { key: string; op: string; value: unknown }[] = [], maximum = 100) => ({
    path,
    doc: (id = `id-${++sequence}`) => doc(`${path}/${id}`),
    where: (key: string, op: string, value: unknown) => collection(path, [...filters, { key, op, value }], maximum),
    limit: (size: number) => collection(path, filters, size),
    get: async () => {
      const docs = [...data].filter(([key, fields]) => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1
        && filters.every((filter) => filter.op === '==' ? fields[filter.key] === filter.value
          : filter.op === 'in' ? (filter.value as unknown[]).includes(fields[filter.key])
            : (fields[filter.key] as Timestamp).toMillis() <= (filter.value as Timestamp).toMillis()))
        .slice(0, maximum).map(([key]) => snapshot(doc(key)));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  const db = { doc, collection,
    recursiveDelete: async (ref: { path: string }) => { for (const path of data.keys()) if (path === ref.path || path.startsWith(ref.path + '/')) data.delete(path); },
    runTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        const pending = new Map(data);
        let writing = false;
        const write = (ref: { path: string }, fields: Data, merge = false) => {
          writing = true;
          const next = { ...(merge ? pending.get(ref.path) : {}), ...fields };
          for (const [key, value] of Object.entries(next)) {
            if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete next[key];
            else if (value instanceof FieldValue && value.isEqual(FieldValue.serverTimestamp())) next[key] = Timestamp.now();
          }
          pending.set(ref.path, next);
        };
        const result = await work({
          get: async (ref: { path: string; id: string }) => { if (writing) throw new Error('Firestore read after write'); return snapshot(ref, pending); },
          set: write,
          create: (ref: { path: string }, fields: Data) => { if (pending.has(ref.path)) throw new Error('Document exists'); write(ref, fields); },
          update: (ref: { path: string }, fields: Data) => { if (!pending.has(ref.path)) throw new Error('Document missing'); write(ref, fields, true); },
        });
        data.clear(); for (const item of pending) data.set(...item);
        return result;
      });
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
  return { data, db: db as unknown as Firestore };
}
