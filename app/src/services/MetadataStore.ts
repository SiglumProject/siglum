/**
 * MetadataStore - Document metadata persistence
 *
 * Stores only document metadata in IndexedDB.
 * Document content is stored in the filesystem via FileSystemService.
 *
 * This replaces the old DocumentStore which stored content directly.
 */

import type { DocumentMetadata } from '../types/Document'

const DB_NAME = 'siglum_metadata'
const DB_VERSION = 1
const METADATA_STORE = 'metadata'

class MetadataStore {
  private dbPromise: Promise<IDBDatabase>

  constructor() {
    this.dbPromise = this.initDB()
  }

  private async initDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          const store = db.createObjectStore(METADATA_STORE, { keyPath: 'id' })
          store.createIndex('title', 'title', { unique: false })
          store.createIndex('updatedAt', 'updatedAt', { unique: false })
          store.createIndex('createdAt', 'createdAt', { unique: false })
          store.createIndex('lastViewedAt', 'lastViewedAt', { unique: false })
          store.createIndex('filePath', 'filePath', { unique: true })
        }
      }
    })
  }

  async create(metadata: DocumentMetadata): Promise<DocumentMetadata> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readwrite')
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.add(metadata)

      request.onsuccess = () => resolve(metadata)
      request.onerror = () => reject(request.error)
    })
  }

  async update(id: string, updates: Partial<Omit<DocumentMetadata, 'id'>>): Promise<DocumentMetadata> {
    const db = await this.dbPromise
    const existing = await this.getById(id)

    if (!existing) {
      throw new Error(`Document metadata with id ${id} not found`)
    }

    const updated: DocumentMetadata = {
      ...existing,
      ...updates,
      updatedAt: new Date()
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readwrite')
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.put(updated)

      request.onsuccess = () => resolve(updated)
      request.onerror = () => reject(request.error)
    })
  }

  async getById(id: string): Promise<DocumentMetadata | null> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readonly')
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.get(id)

      request.onsuccess = () => {
        const result = request.result
        if (result) {
          // Ensure dates are Date objects
          result.createdAt = new Date(result.createdAt)
          result.updatedAt = new Date(result.updatedAt)
          result.lastViewedAt = new Date(result.lastViewedAt)
        }
        resolve(result || null)
      }
      request.onerror = () => reject(request.error)
    })
  }

  async getByFilePath(filePath: string): Promise<DocumentMetadata | null> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readonly')
      const store = transaction.objectStore(METADATA_STORE)
      const index = store.index('filePath')
      const request = index.get(filePath)

      request.onsuccess = () => {
        const result = request.result
        if (result) {
          result.createdAt = new Date(result.createdAt)
          result.updatedAt = new Date(result.updatedAt)
          result.lastViewedAt = new Date(result.lastViewedAt)
        }
        resolve(result || null)
      }
      request.onerror = () => reject(request.error)
    })
  }

  async getAll(): Promise<DocumentMetadata[]> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readonly')
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.getAll()

      request.onsuccess = () => {
        const results = request.result.map(item => ({
          ...item,
          createdAt: new Date(item.createdAt),
          updatedAt: new Date(item.updatedAt),
          lastViewedAt: new Date(item.lastViewedAt)
        }))
        resolve(results)
      }
      request.onerror = () => reject(request.error)
    })
  }

  async getRecent(limit: number = 10): Promise<DocumentMetadata[]> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readonly')
      const store = transaction.objectStore(METADATA_STORE)
      const index = store.index('lastViewedAt')
      const request = index.openCursor(null, 'prev')

      const results: DocumentMetadata[] = []

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result
        if (cursor && results.length < limit) {
          const item = cursor.value
          results.push({
            ...item,
            createdAt: new Date(item.createdAt),
            updatedAt: new Date(item.updatedAt),
            lastViewedAt: new Date(item.lastViewedAt)
          })
          cursor.continue()
        } else {
          resolve(results)
        }
      }

      request.onerror = () => reject(request.error)
    })
  }

  async delete(id: string): Promise<void> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readwrite')
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.delete(id)

      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  async updateLastViewed(id: string): Promise<void> {
    await this.update(id, { lastViewedAt: new Date() })
  }

  async count(): Promise<number> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([METADATA_STORE], 'readonly')
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.count()

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
}

export default new MetadataStore()
