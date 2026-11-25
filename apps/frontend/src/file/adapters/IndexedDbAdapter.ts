import type { ModelDocument } from "../../model/types";
import type { ImportResult, ModelEntry, ModelRef, StorageAdapter } from "../StorageAdapter";
import { deserialize } from "../deserializer";
import { exportModel } from "../export";
import { importModel } from "../import";
import { serialize } from "../serializer";
import {
  DB_NAME,
  DB_VERSION,
  MODELS_STORE,
  type StoredModelRecord,
  upgradeDatabase,
} from "./idb-schema";

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function cloneDocument(document: ModelDocument): ModelDocument {
  return deserialize(serialize(document));
}

export class IndexedDbAdapter implements StorageAdapter {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDatabase(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          upgradeDatabase(request.result);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
      });
    }
    return this.dbPromise;
  }

  private async putRecord(record: StoredModelRecord): Promise<void> {
    const db = await this.openDatabase();
    const transaction = db.transaction(MODELS_STORE, "readwrite");
    transaction.objectStore(MODELS_STORE).put(record);
    await transactionDone(transaction);
  }

  async list(): Promise<ModelEntry[]> {
    const db = await this.openDatabase();
    const transaction = db.transaction(MODELS_STORE, "readonly");
    const records = (await requestToPromise(
      transaction.objectStore(MODELS_STORE).getAll(),
    )) as StoredModelRecord[];
    await transactionDone(transaction);
    return records
      .map((record) => ({
        id: record.id,
        name: record.name,
        modifiedAt: record.modifiedAt,
        openedAt: record.openedAt,
      }))
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  }

  async load(id: ModelRef): Promise<ModelDocument> {
    const db = await this.openDatabase();
    const transaction = db.transaction(MODELS_STORE, "readwrite");
    const store = transaction.objectStore(MODELS_STORE);
    const record = (await requestToPromise(store.get(id))) as StoredModelRecord | undefined;
    if (!record) {
      transaction.abort();
      throw new Error(`Model not found: ${id}`);
    }
    const openedAt = new Date().toISOString();
    store.put({ ...record, openedAt });
    await transactionDone(transaction);
    return deserialize(serialize(record.document as ModelDocument));
  }

  async save(id: ModelRef, doc: ModelDocument): Promise<void> {
    const now = new Date().toISOString();
    await this.putRecord({
      id,
      name: doc.model.name,
      document: cloneDocument(doc),
      modifiedAt: now,
      openedAt: now,
    });
  }

  /**
   * Store `doc` under a ref of its own and return that ref.
   *
   * This used to rewrite the document before writing it: `model.id` became
   * `<id>-copy-<timestamp>` and `model.name` gained a " Copy" suffix. So every
   * call duplicated the model rather than storing it, and neither caller asks
   * for a duplicate — `saveFile()` routes the *first* save of a never-saved
   * model here, because there is no ref yet, and the `file.save-as` command's
   * own toast says "Model saved".
   *
   * What that cost, measured: build a model, press Ctrl+S once, reload, open it
   * from the startup list, and you get "<name> Copy" under a record keyed
   * `model-1-copy-<timestamp>` — while the in-memory document keeps its own id
   * and name, so nothing on screen says anything happened. A second Ctrl+S then
   * writes the real document back under the copy's key, leaving a record whose
   * key and `model.id` disagree. Hence a user who saves, closes and reopens is
   * quietly working on a duplicate from then on.
   *
   * A storage adapter allocates refs. Renaming the user's model is not its
   * decision to make, so the document is written through untouched and the ref
   * is its own `model.id` — the two stay in step, and a save → open round trip
   * is byte-identical. The timestamp suffix is only for the case the name
   * implies: a Save As over a model that is already stored, where a fresh key is
   * the whole point and clobbering the original would not be.
   */
  async saveAs(doc: ModelDocument): Promise<ModelRef> {
    const ref = (await this.hasRecord(doc.model.id))
      ? `${doc.model.id}-${Date.now()}`
      : doc.model.id;
    await this.save(ref, doc);
    return ref;
  }

  /** Whether a record is already stored under this ref. */
  private async hasRecord(id: ModelRef): Promise<boolean> {
    const db = await this.openDatabase();
    const transaction = db.transaction(MODELS_STORE, "readonly");
    const key = await requestToPromise(transaction.objectStore(MODELS_STORE).getKey(id));
    await transactionDone(transaction);
    return key !== undefined;
  }

  async delete(id: ModelRef): Promise<void> {
    const db = await this.openDatabase();
    const transaction = db.transaction(MODELS_STORE, "readwrite");
    transaction.objectStore(MODELS_STORE).delete(id);
    await transactionDone(transaction);
  }

  async importFromFile(): Promise<ImportResult> {
    const document = await importModel();
    if (!document) {
      throw new Error("Import cancelled");
    }
    const imported = cloneDocument(document);
    const id = `${imported.model.id}-${Date.now()}`;
    imported.model.id = id;
    await this.save(id, imported);
    return { document: imported, ref: id };
  }

  async exportToFile(doc: ModelDocument): Promise<void> {
    exportModel(doc);
  }
}

export default IndexedDbAdapter;
