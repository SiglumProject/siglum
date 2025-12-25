import type { SiglumDocument, SearchResult } from '../types/Document'
import DocumentService from './DocumentService'

export interface SearchOptions {
  maxResults?: number
  includeContent?: boolean
  fuzzyMatch?: boolean
}

class DocumentSearcher {
  private searchIndex: Map<string, Set<string>> = new Map() // word -> document IDs
  private documentCache: Map<string, SiglumDocument> = new Map()
  private isIndexed = false

  async initialize(): Promise<void> {
    if (this.isIndexed) return

    await DocumentService.initialize()
    const documents = await DocumentService.getAll()
    for (const doc of documents) {
      this.indexDocument(doc)
    }
    this.isIndexed = true
  }

  indexDocument(doc: SiglumDocument): void {
    this.documentCache.set(doc.id, doc)
    
    // Remove old index entries for this document
    this.removeFromIndex(doc.id)
    
    // Index title and content separately
    const titleWords = this.extractWords(doc.title, 2.0) // Title gets higher weight
    const contentWords = this.extractWords(doc.searchableText, 1.0)
    
    const allWords = new Map<string, number>()
    
    // Combine words with weights
    titleWords.forEach((weight, word) => {
      allWords.set(word, (allWords.get(word) || 0) + weight)
    })
    contentWords.forEach((weight, word) => {
      allWords.set(word, (allWords.get(word) || 0) + weight)
    })
    
    // Add to search index
    allWords.forEach((_weight, word) => {
      if (!this.searchIndex.has(word)) {
        this.searchIndex.set(word, new Set())
      }
      this.searchIndex.get(word)!.add(doc.id)
    })
  }

  private extractWords(text: string, weight: number = 1.0): Map<string, number> {
    const words = new Map<string, number>()
    const cleanText = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
    
    if (!cleanText) return words
    
    const wordList = cleanText.split(' ').filter(word => word.length > 2)
    
    for (const word of wordList) {
      words.set(word, weight)
      
      // Also index word prefixes for partial matching
      if (word.length > 4) {
        for (let i = 3; i <= Math.min(word.length - 1, 6); i++) {
          const prefix = word.substring(0, i)
          words.set(prefix, weight * 0.5) // Lower weight for prefixes
        }
      }
    }
    
    return words
  }

  private removeFromIndex(documentId: string): void {
    for (const [word, docIds] of this.searchIndex.entries()) {
      docIds.delete(documentId)
      if (docIds.size === 0) {
        this.searchIndex.delete(word)
      }
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    await this.initialize()
    
    if (!query.trim()) {
      return this.getRecentDocuments(options.maxResults || 10)
    }

    const {
      maxResults = 10,
      includeContent = false,
      fuzzyMatch = true
    } = options

    const queryWords = this.extractWords(query.toLowerCase())
    const documentScores = new Map<string, number>()
    
    // Score documents based on word matches
    for (const [word] of queryWords) {
      // Exact word matches
      const exactMatches = this.searchIndex.get(word) || new Set()
      for (const docId of exactMatches) {
        const currentScore = documentScores.get(docId) || 0
        documentScores.set(docId, currentScore + 2.0) // Exact match gets high score
      }
      
      // Fuzzy matches if enabled
      if (fuzzyMatch && word.length > 3) {
        for (const [indexWord, docIds] of this.searchIndex.entries()) {
          if (indexWord.includes(word) || word.includes(indexWord)) {
            const similarity = this.calculateSimilarity(word, indexWord)
            if (similarity > 0.6) {
              for (const docId of docIds) {
                const currentScore = documentScores.get(docId) || 0
                documentScores.set(docId, currentScore + similarity)
              }
            }
          }
        }
      }
    }
    
    // Check for phrase matches (higher score)
    if (query.includes(' ')) {
      const phrase = query.toLowerCase().trim()
      for (const doc of this.documentCache.values()) {
        if (doc.title.toLowerCase().includes(phrase)) {
          const currentScore = documentScores.get(doc.id) || 0
          documentScores.set(doc.id, currentScore + 5.0) // Phrase in title = highest score
        } else if (doc.searchableText.toLowerCase().includes(phrase)) {
          const currentScore = documentScores.get(doc.id) || 0
          documentScores.set(doc.id, currentScore + 3.0) // Phrase in content = high score
        }
      }
    }
    
    // Apply recency boost
    const now = Date.now()
    for (const [docId, score] of documentScores.entries()) {
      const doc = this.documentCache.get(docId)
      if (doc) {
        const daysSinceViewed = (now - doc.lastViewedAt.getTime()) / (1000 * 60 * 60 * 24)
        const recencyMultiplier = Math.max(0.1, 1 - (daysSinceViewed / 30)) // Recent docs get boost
        documentScores.set(docId, score * (1 + recencyMultiplier * 0.5))
      }
    }
    
    // Sort by score and convert to SearchResult
    const sortedResults = Array.from(documentScores.entries())
      .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
      .slice(0, maxResults)
      .map(([docId, score]): SearchResult => {
        const doc = this.documentCache.get(docId)!
        const highlights = this.getHighlights(doc, queryWords, includeContent)
        return {
          document: doc,
          relevanceScore: score,
          matchedTerms: Array.from(queryWords.keys()),
          snippet: highlights[0] || '',
          highlights
        }
      })

    return sortedResults
  }

  private async getRecentDocuments(maxResults: number): Promise<SearchResult[]> {
    const recentDocs = await DocumentService.getRecent(maxResults)
    return recentDocs.map(doc => ({
      document: doc,
      relevanceScore: 1.0,
      matchedTerms: [],
      snippet: '',
      highlights: []
    }))
  }

  private calculateSimilarity(word1: string, word2: string): number {
    const longer = word1.length > word2.length ? word1 : word2
    const shorter = word1.length <= word2.length ? word1 : word2
    
    if (longer.length === 0) return 1.0
    
    const editDistance = this.levenshteinDistance(longer, shorter)
    return (longer.length - editDistance) / longer.length
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null))
    
    for (let i = 0; i <= str1.length; i++) {
      matrix[0][i] = i
    }
    
    for (let j = 0; j <= str2.length; j++) {
      matrix[j][0] = j
    }
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        if (str1[i - 1] === str2[j - 1]) {
          matrix[j][i] = matrix[j - 1][i - 1]
        } else {
          matrix[j][i] = Math.min(
            matrix[j - 1][i - 1] + 1, // substitution
            matrix[j][i - 1] + 1,     // insertion
            matrix[j - 1][i] + 1      // deletion
          )
        }
      }
    }
    
    return matrix[str2.length][str1.length]
  }

  private getHighlights(doc: SiglumDocument, queryWords: Map<string, number>, includeContent: boolean): string[] {
    const highlights: string[] = []
    
    // Always highlight in title
    let titleHighlight = this.highlightText(doc.title, queryWords)
    if (titleHighlight !== doc.title) {
      highlights.push(titleHighlight)
    }
    
    // Optionally highlight in content
    if (includeContent) {
      const contentPreview = doc.searchableText.substring(0, 200)
      const contentHighlight = this.highlightText(contentPreview, queryWords)
      if (contentHighlight !== contentPreview) {
        highlights.push(contentHighlight + '...')
      }
    }
    
    return highlights
  }

  private highlightText(text: string, queryWords: Map<string, number>): string {
    let result = text
    for (const [word] of queryWords) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi')
      result = result.replace(regex, `<mark>$&</mark>`)
    }
    return result
  }

  // Update methods for real-time indexing
  async updateDocument(doc: SiglumDocument): Promise<void> {
    this.indexDocument(doc)
  }

  async removeDocument(docId: string): Promise<void> {
    this.removeFromIndex(docId)
    this.documentCache.delete(docId)
  }
}

export default new DocumentSearcher()