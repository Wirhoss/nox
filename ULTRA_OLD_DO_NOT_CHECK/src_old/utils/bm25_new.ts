type BM25Tokenizer = (text: string) => Iterable<string>;

interface BM25Options {
  k1?: number;
  b?: number;
  /**
   * Optional custom tokenizer. Returned terms must already have the desired
   * case-folding and normalization applied. Empty terms are ignored.
   */
  tokenizer?: BM25Tokenizer;
}

interface SearchResult {
  docIndex: number;
  score: number;
}

interface PostingList {
  docIds: Uint32Array;
  termFrequencies: Uint32Array;
  length: number;
  lastQueryEpoch: number;
}

const LATIN_COMBINING_MARKS = /(\p{Script=Latin})\p{M}+/gu;
const HAS_NON_ASCII = /[^\x00-\x7f]/;
const INITIAL_DOCUMENT_CAPACITY = 16;
const INITIAL_POSTING_CAPACITY = 1;

function normalizeText(text: string, hasNonAscii: boolean): string {
  const lower = text.toLowerCase();
  if (!hasNonAscii) return lower;

  // Preserve the previous accent-insensitive behavior for Latin scripts while
  // retaining letters and combining marks used by other writing systems.
  return lower.normalize('NFD').replace(LATIN_COMBINING_MARKS, '$1');
}

function createPostingList(): PostingList {
  return {
    docIds: new Uint32Array(INITIAL_POSTING_CAPACITY),
    termFrequencies: new Uint32Array(INITIAL_POSTING_CAPACITY),
    length: 0,
    lastQueryEpoch: 0,
  };
}

function appendPosting(postings: PostingList, docIndex: number, termFrequency: number): void {
  if (postings.length === postings.docIds.length) {
    const capacity = postings.length * 2;
    const docIds = new Uint32Array(capacity);
    const termFrequencies = new Uint32Array(capacity);
    docIds.set(postings.docIds);
    termFrequencies.set(postings.termFrequencies);
    postings.docIds = docIds;
    postings.termFrequencies = termFrequencies;
  }

  postings.docIds[postings.length] = docIndex;
  postings.termFrequencies[postings.length] = termFrequency;
  postings.length++;
}

/**
 * Exact BM25 index optimized for low-allocation, term-at-a-time searches.
 *
 * The built-in tokenizer lowercases text, folds Latin diacritics, and accepts
 * Unicode letters, numbers, and combining marks. Whitespace and punctuation
 * delimit terms; languages that do not mark word boundaries should provide a
 * custom tokenizer (for example, one backed by Intl.Segmenter).
 *
 * Repeated query terms are deduplicated. Search uses mutable scratch buffers,
 * so calls on the same instance must remain synchronous and non-reentrant.
 *
 * Documents can be appended without rebuilding the index. IDF and document
 * length normalization use the current corpus statistics at search time, so
 * results remain exact after each insertion.
 */
class BM25 {
  private readonly k1: number;
  private readonly b: number;
  private readonly k1PlusOne: number;
  private readonly normalizationOffset: number;
  private readonly tokenizer?: BM25Tokenizer;
  private readonly asciiTokenPattern = /[a-z0-9]+/g;
  private readonly unicodeTokenPattern = /[\p{L}\p{N}\p{M}]+/gu;

  private readonly terms = new Map<string, PostingList>();
  private readonly queryPostings: PostingList[] = [];

  private docLengths = new Uint32Array(0);
  private scores = new Float64Array(0);
  private scoreEpochs = new Uint32Array(0);
  private touchedDocs = new Uint32Array(0);
  private heapDocIndexes = new Uint32Array(0);
  private heapScores = new Float64Array(0);

  private totalDocumentLength = 0;
  private documentCountValue = 0;
  private currentEpoch = 0;

  constructor(corpus: readonly string[] = [], options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.tokenizer = options.tokenizer;

    if (!Number.isFinite(this.k1) || this.k1 < 0) {
      throw new RangeError('k1 must be a finite number greater than or equal to 0');
    }
    if (!Number.isFinite(this.b) || this.b < 0 || this.b > 1) {
      throw new RangeError('b must be a finite number between 0 and 1');
    }

    this.k1PlusOne = this.k1 + 1;
    this.normalizationOffset = this.k1 * (1 - this.b);

    this.ensureDocumentCapacity(corpus.length);
    for (const document of corpus) this.addDocument(document);
  }

  get documentCount(): number {
    return this.documentCountValue;
  }

  addDocument(text: string): number {
    if (this.documentCountValue === 0xffffffff) {
      throw new RangeError('BM25 supports at most 4,294,967,295 documents');
    }

    const docIndex = this.documentCountValue;
    this.ensureDocumentCapacity(docIndex + 1);

    const frequencies = new Map<string, number>();
    let documentLength = 0;

    if (this.tokenizer) {
      for (const term of this.tokenizer(text)) {
        if (term.length === 0) continue;
        frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
        documentLength++;
      }
    } else {
      const hasNonAscii = HAS_NON_ASCII.test(text);
      const normalized = normalizeText(text, hasNonAscii);
      const tokenPattern = hasNonAscii
        ? this.unicodeTokenPattern
        : this.asciiTokenPattern;
      tokenPattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = tokenPattern.exec(normalized)) !== null) {
        const term = match[0]!;
        frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
        documentLength++;
      }
    }

    this.docLengths[docIndex] = documentLength;
    this.totalDocumentLength += documentLength;
    this.documentCountValue++;

    for (const [term, termFrequency] of frequencies) {
      let postings = this.terms.get(term);
      if (!postings) {
        postings = createPostingList();
        this.terms.set(term, postings);
      }
      appendPosting(postings, docIndex, termFrequency);
    }

    return docIndex;
  }

  addDocuments(documents: readonly string[]): number[] {
    const firstDocIndex = this.documentCountValue;
    this.ensureDocumentCapacity(firstDocIndex + documents.length);

    const docIndexes = new Array<number>(documents.length);
    for (let i = 0; i < documents.length; i++) {
      docIndexes[i] = this.addDocument(documents[i]!);
    }
    return docIndexes;
  }

  search(query: string, topK = 5): SearchResult[] {
    const limit = this.resolveLimit(topK);
    if (limit === 0) return [];

    const resultCount = this.rank(query, limit);
    if (resultCount === 0) return [];

    this.sortHeapDescending(resultCount);

    const results = new Array<SearchResult>(resultCount);
    for (let i = 0; i < resultCount; i++) {
      results[i] = {
        docIndex: this.heapDocIndexes[i]!,
        score: this.heapScores[i]!,
      };
    }
    return results;
  }

  /**
   * Allocation-free result path. Writes sorted results into caller-provided
   * buffers and returns the number of positions written.
   */
  searchInto(
    query: string,
    docIndexes: Uint32Array,
    scores: Float64Array,
    topK = Math.min(docIndexes.length, scores.length),
  ): number {
    const limit = this.resolveLimit(topK);
    if (docIndexes.length < limit || scores.length < limit) {
      throw new RangeError('searchInto output buffers must have at least topK positions');
    }
    if (limit === 0) return 0;

    const resultCount = this.rank(query, limit);
    if (resultCount === 0) return 0;

    this.sortHeapDescending(resultCount);
    for (let i = 0; i < resultCount; i++) {
      docIndexes[i] = this.heapDocIndexes[i]!;
      scores[i] = this.heapScores[i]!;
    }
    return resultCount;
  }

  private rank(query: string, limit: number): number {
    if (this.totalDocumentLength === 0) return 0;

    let epoch = (this.currentEpoch + 1) >>> 0;
    if (epoch === 0) {
      this.scoreEpochs.fill(0);
      for (const postings of this.terms.values()) postings.lastQueryEpoch = 0;
      epoch = 1;
    }
    this.currentEpoch = epoch;

    this.queryPostings.length = 0;
    if (this.tokenizer) {
      for (const term of this.tokenizer(query)) {
        if (term.length === 0) continue;
        const postings = this.terms.get(term);
        if (!postings || postings.lastQueryEpoch === epoch) continue;
        postings.lastQueryEpoch = epoch;
        this.queryPostings.push(postings);
      }
    } else {
      const hasNonAscii = HAS_NON_ASCII.test(query);
      const normalizedQuery = normalizeText(query, hasNonAscii);
      const tokenPattern = hasNonAscii
        ? this.unicodeTokenPattern
        : this.asciiTokenPattern;
      tokenPattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = tokenPattern.exec(normalizedQuery)) !== null) {
        const postings = this.terms.get(match[0]!);
        if (!postings || postings.lastQueryEpoch === epoch) continue;
        postings.lastQueryEpoch = epoch;
        this.queryPostings.push(postings);
      }
    }

    if (this.queryPostings.length === 0) return 0;

    // k1 * (1 - b + b * docLength / avgDocumentLength), split into
    // a constant and one multiplication per posting.
    const normalizationScale =
      this.k1 * this.b * this.documentCountValue / this.totalDocumentLength;
    let touchedCount = 0;

    for (const postings of this.queryPostings) {
      const documentFrequency = postings.length;
      const idf = Math.log1p(
        (this.documentCountValue - documentFrequency + 0.5) /
        (documentFrequency + 0.5),
      );
      const termScale = idf * this.k1PlusOne;

      const docIds = postings.docIds;
      const termFrequencies = postings.termFrequencies;
      for (let i = 0; i < documentFrequency; i++) {
        const docIndex = docIds[i]!;
        const termFrequency = termFrequencies[i]!;
        const contribution =
          termScale * termFrequency /
          (termFrequency + this.normalizationOffset +
            normalizationScale * this.docLengths[docIndex]!);

        if (this.scoreEpochs[docIndex] !== epoch) {
          this.scoreEpochs[docIndex] = epoch;
          this.scores[docIndex] = contribution;
          this.touchedDocs[touchedCount++] = docIndex;
        } else {
          this.scores[docIndex]! += contribution;
        }
      }
    }

    if (touchedCount === 0) return 0;

    this.ensureHeapCapacity(Math.min(limit, touchedCount));
    let heapLength = 0;

    // The root is the worst retained result. On ties, lower docIndex wins.
    for (let i = 0; i < touchedCount; i++) {
      const docIndex = this.touchedDocs[i]!;
      const score = this.scores[docIndex]!;

      if (heapLength < limit) {
        let position = heapLength++;
        while (position > 0) {
          const parent = (position - 1) >>> 1;
          const parentScore = this.heapScores[parent]!;
          const parentDocIndex = this.heapDocIndexes[parent]!;
          const candidateIsWorse =
            score < parentScore || (score === parentScore && docIndex > parentDocIndex);
          if (!candidateIsWorse) break;

          this.heapScores[position] = parentScore;
          this.heapDocIndexes[position] = parentDocIndex;
          position = parent;
        }
        this.heapScores[position] = score;
        this.heapDocIndexes[position] = docIndex;
        continue;
      }

      const worstScore = this.heapScores[0]!;
      const worstDocIndex = this.heapDocIndexes[0]!;
      const candidateIsBetter =
        score > worstScore || (score === worstScore && docIndex < worstDocIndex);
      if (!candidateIsBetter) continue;

      let position = 0;
      while (true) {
        const left = position * 2 + 1;
        if (left >= heapLength) break;

        const right = left + 1;
        let worseChild = left;
        if (right < heapLength && this.isHeapEntryWorse(right, left)) worseChild = right;

        const childScore = this.heapScores[worseChild]!;
        const childDocIndex = this.heapDocIndexes[worseChild]!;
        const childIsWorse =
          childScore < score || (childScore === score && childDocIndex > docIndex);
        if (!childIsWorse) break;

        this.heapScores[position] = childScore;
        this.heapDocIndexes[position] = childDocIndex;
        position = worseChild;
      }
      this.heapScores[position] = score;
      this.heapDocIndexes[position] = docIndex;
    }

    return heapLength;
  }

  private sortHeapDescending(length: number): void {
    // Extracting the minimum into the end of a min-heap leaves the arrays in
    // best-to-worst order without allocating another sorting structure.
    for (let end = length - 1; end > 0; end--) {
      const rootScore = this.heapScores[0]!;
      const rootDocIndex = this.heapDocIndexes[0]!;
      const replacementScore = this.heapScores[end]!;
      const replacementDocIndex = this.heapDocIndexes[end]!;

      this.heapScores[end] = rootScore;
      this.heapDocIndexes[end] = rootDocIndex;

      let position = 0;
      while (true) {
        const left = position * 2 + 1;
        if (left >= end) break;

        const right = left + 1;
        let worseChild = left;
        if (right < end && this.isHeapEntryWorse(right, left)) worseChild = right;

        const childScore = this.heapScores[worseChild]!;
        const childDocIndex = this.heapDocIndexes[worseChild]!;
        const childIsWorse =
          childScore < replacementScore ||
          (childScore === replacementScore && childDocIndex > replacementDocIndex);
        if (!childIsWorse) break;

        this.heapScores[position] = childScore;
        this.heapDocIndexes[position] = childDocIndex;
        position = worseChild;
      }

      this.heapScores[position] = replacementScore;
      this.heapDocIndexes[position] = replacementDocIndex;
    }
  }

  private isHeapEntryWorse(a: number, b: number): boolean {
    const aScore = this.heapScores[a]!;
    const bScore = this.heapScores[b]!;
    return aScore < bScore ||
      (aScore === bScore && this.heapDocIndexes[a]! > this.heapDocIndexes[b]!);
  }

  private resolveLimit(topK: number): number {
    if (this.documentCountValue === 0 || !(topK > 0)) return 0;
    return Math.min(this.documentCountValue, Math.floor(topK));
  }

  private ensureDocumentCapacity(required: number): void {
    if (required <= this.docLengths.length) return;

    let capacity = Math.max(INITIAL_DOCUMENT_CAPACITY, this.docLengths.length);
    while (capacity < required) capacity *= 2;

    const docLengths = new Uint32Array(capacity);
    docLengths.set(this.docLengths);

    // Search buffers are scratch space. Their previous contents do not need to
    // survive growth: a zero epoch guarantees scores are assigned before read.
    this.docLengths = docLengths;
    this.scores = new Float64Array(capacity);
    this.scoreEpochs = new Uint32Array(capacity);
    this.touchedDocs = new Uint32Array(capacity);
  }

  private ensureHeapCapacity(required: number): void {
    if (required <= this.heapDocIndexes.length) return;

    let capacity = Math.max(8, this.heapDocIndexes.length);
    while (capacity < required) capacity *= 2;

    // Heap contents are scratch and are fully rebuilt by rank().
    this.heapDocIndexes = new Uint32Array(capacity);
    this.heapScores = new Float64Array(capacity);
  }
}

export {
  BM25,
  type BM25Options,
  type BM25Tokenizer,
  type SearchResult,
};
