/**
 * DocumentService - Unified document operations
 *
 * Orchestrates between:
 * - MetadataStore (IndexedDB) for document metadata
 * - OPFS (Origin Private File System) for document content
 *
 * Handles migrations from:
 * - Old DocumentStore format (siglum_documents IndexedDB)
 * - IndexedDB filesystem backend (siglum_filesystem IndexedDB)
 */

import type { SiglumDocument, DocumentMetadata } from '../types/Document'
import { toSiglumDocument } from '../types/Document'
import MetadataStore from './MetadataStore'
import { fileSystem, getBestBackend, indexedDBBackend } from '@siglum/filesystem'
import { extractTitle, extractSearchableText, countWords } from '../utils/latexParsing'

const DOCUMENTS_PATH = '/documents'
const MIGRATION_KEY = 'siglum_opfs_migration_v1'

class DocumentService {
  private initialized = false
  private initPromise: Promise<void> | null = null

  /**
   * Initialize the service, run migrations if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._initialize()
    await this.initPromise
    this.initialized = true
  }

  private async _initialize(): Promise<void> {
    // Mount best available filesystem (OPFS on Chrome/Firefox, IndexedDB on Safari)
    const backend = await getBestBackend()
    fileSystem.mount(DOCUMENTS_PATH, backend)

    // Run migrations if needed
    await this.migrateIfNeeded()
  }

  /**
   * Run migrations if needed
   * Handles migration from:
   * 1. Old DocumentStore format (siglum_documents)
   * 2. IndexedDB filesystem (siglum_filesystem) to OPFS
   */
  private async migrateIfNeeded(): Promise<void> {
    // Check if we've already completed OPFS migration
    const migrationDone = localStorage.getItem(MIGRATION_KEY)
    if (migrationDone === 'complete') {
      return
    }

    // Step 1: Migrate from old DocumentStore if it exists
    const oldDocStoreExists = await this.checkDatabaseExists('siglum_documents', 'documents')
    if (oldDocStoreExists) {
      const existingCount = await MetadataStore.count()
      if (existingCount === 0) {
        console.log('[DocumentService] Migrating from old DocumentStore...')
        await this.migrateFromOldDocumentStore()
      }
    }

    // Step 2: Migrate from IndexedDB filesystem to OPFS
    const indexedDbFsExists = await this.checkDatabaseExists('siglum_filesystem', 'files')
    if (indexedDbFsExists) {
      console.log('[DocumentService] Migrating files from IndexedDB to OPFS...')
      await this.migrateFromIndexedDBToOPFS()
    }

    // Mark migration complete
    localStorage.setItem(MIGRATION_KEY, 'complete')
    console.log('[DocumentService] Migration complete')
  }

  private async checkDatabaseExists(dbName: string, storeName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const request = indexedDB.open(dbName, 1)
      request.onsuccess = () => {
        const db = request.result
        const hasStore = db.objectStoreNames.contains(storeName)
        db.close()
        resolve(hasStore)
      }
      request.onerror = () => resolve(false)
      request.onupgradeneeded = () => {
        // Database didn't exist, don't create it
        request.transaction?.abort()
        resolve(false)
      }
    })
  }

  /**
   * Migrate from the original DocumentStore format
   */
  private async migrateFromOldDocumentStore(): Promise<void> {
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('siglum_documents', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    const oldDocs = await new Promise<Array<{
      id: string
      title: string
      content: string
      createdAt: Date
      updatedAt: Date
      lastViewedAt: Date
      wordCount: number
    }>>((resolve, reject) => {
      const transaction = oldDb.transaction(['documents'], 'readonly')
      const store = transaction.objectStore('documents')
      const request = store.getAll()

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    oldDb.close()

    for (const oldDoc of oldDocs) {
      const filePath = `${DOCUMENTS_PATH}/${oldDoc.id}.tex`

      // Write content to OPFS
      await fileSystem.writeFile(filePath, oldDoc.content)

      // Create metadata entry
      const metadata: DocumentMetadata = {
        id: oldDoc.id,
        filePath,
        title: oldDoc.title,
        createdAt: new Date(oldDoc.createdAt),
        updatedAt: new Date(oldDoc.updatedAt),
        lastViewedAt: new Date(oldDoc.lastViewedAt),
        wordCount: oldDoc.wordCount
      }

      await MetadataStore.create(metadata)
    }

    console.log(`[DocumentService] Migrated ${oldDocs.length} documents from DocumentStore`)
  }

  /**
   * Migrate files from IndexedDB filesystem to OPFS
   */
  private async migrateFromIndexedDBToOPFS(): Promise<void> {
    // Temporarily mount IndexedDB backend to read existing files
    const tempPath = '/__migration_temp__'
    fileSystem.mount(tempPath, indexedDBBackend)

    try {
      // Get all metadata entries to find files to migrate
      const allMetadata = await MetadataStore.getAll()
      let migratedCount = 0

      for (const metadata of allMetadata) {
        // Check if file exists in OPFS already
        const opfsExists = await fileSystem.exists(metadata.filePath)
        if (opfsExists) continue

        // Try to read from IndexedDB filesystem
        try {
          const content = await indexedDBBackend.readFile(metadata.filePath)
          // Write to OPFS
          await fileSystem.writeFile(metadata.filePath, content)
          migratedCount++
        } catch {
          // File doesn't exist in IndexedDB either, skip
          console.warn(`[DocumentService] Could not migrate file for document ${metadata.id}`)
        }
      }

      if (migratedCount > 0) {
        console.log(`[DocumentService] Migrated ${migratedCount} files from IndexedDB to OPFS`)
      }
    } finally {
      // Unmount temp path
      fileSystem.unmount(tempPath)
    }
  }

  /**
   * Generate a unique document ID
   */
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9)
  }

  /**
   * Create a new document
   */
  async create(content: string = ''): Promise<SiglumDocument> {
    await this.initialize()

    const id = this.generateId()
    const filePath = `${DOCUMENTS_PATH}/${id}.tex`
    const now = new Date()

    // Write content to filesystem
    await fileSystem.writeFile(filePath, content)

    // Create metadata
    const metadata: DocumentMetadata = {
      id,
      filePath,
      title: extractTitle(content),
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      wordCount: countWords(content)
    }

    await MetadataStore.create(metadata)

    return toSiglumDocument(metadata, content, extractSearchableText(content))
  }

  /**
   * Get a document by ID
   */
  async getById(id: string): Promise<SiglumDocument | null> {
    await this.initialize()

    const metadata = await MetadataStore.getById(id)
    if (!metadata) return null

    try {
      const content = await fileSystem.readFile(metadata.filePath)
      return toSiglumDocument(metadata, content, extractSearchableText(content))
    } catch {
      // File might be missing, return null
      console.warn(`[DocumentService] Content file missing for document ${id}`)
      return null
    }
  }

  /**
   * Get all documents (metadata only for performance)
   */
  async getAllMetadata(): Promise<DocumentMetadata[]> {
    await this.initialize()
    return MetadataStore.getAll()
  }

  /**
   * Get all documents with content loaded
   */
  async getAll(): Promise<SiglumDocument[]> {
    await this.initialize()

    const allMetadata = await MetadataStore.getAll()
    const documents: SiglumDocument[] = []

    for (const metadata of allMetadata) {
      try {
        const content = await fileSystem.readFile(metadata.filePath)
        documents.push(toSiglumDocument(metadata, content, extractSearchableText(content)))
      } catch {
        console.warn(`[DocumentService] Content file missing for document ${metadata.id}`)
      }
    }

    return documents
  }

  /**
   * Get recent documents
   */
  async getRecent(limit: number = 10): Promise<SiglumDocument[]> {
    await this.initialize()

    const recentMetadata = await MetadataStore.getRecent(limit)
    const documents: SiglumDocument[] = []

    for (const metadata of recentMetadata) {
      try {
        const content = await fileSystem.readFile(metadata.filePath)
        documents.push(toSiglumDocument(metadata, content, extractSearchableText(content)))
      } catch {
        // Silently clean up orphaned metadata
        MetadataStore.delete(metadata.id).catch(() => {})
      }
    }

    return documents
  }

  /**
   * Update a document
   */
  async update(id: string, updates: { content?: string; title?: string }): Promise<SiglumDocument> {
    await this.initialize()

    const metadata = await MetadataStore.getById(id)
    if (!metadata) {
      throw new Error(`Document with id ${id} not found`)
    }

    let content: string
    if (updates.content !== undefined) {
      content = updates.content
      // Write new content to filesystem
      await fileSystem.writeFile(metadata.filePath, content)
    } else {
      content = await fileSystem.readFile(metadata.filePath)
    }

    // Update metadata
    const updatedMetadata = await MetadataStore.update(id, {
      title: updates.title ?? extractTitle(content),
      wordCount: countWords(content),
      updatedAt: new Date()
    })

    return toSiglumDocument(updatedMetadata, content, extractSearchableText(content))
  }

  /**
   * Delete a document
   */
  async delete(id: string): Promise<void> {
    await this.initialize()

    const metadata = await MetadataStore.getById(id)
    if (!metadata) return

    // Delete content file
    try {
      await fileSystem.deleteFile(metadata.filePath)
    } catch {
      // File might already be missing
    }

    // Delete metadata
    await MetadataStore.delete(id)
  }

  /**
   * Update last viewed timestamp
   */
  async updateLastViewed(id: string): Promise<void> {
    await this.initialize()
    await MetadataStore.updateLastViewed(id)
  }

  /**
   * Check if a document exists
   */
  async exists(id: string): Promise<boolean> {
    await this.initialize()
    const metadata = await MetadataStore.getById(id)
    return metadata !== null
  }
}

export default new DocumentService()
