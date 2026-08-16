type BM25Tokenizer = (text: string) => Iterable<string>;

interface BM25Options {
  b?: number;
  k1?: number;
  tokenizer?: BM25Tokenizer;
}

interface SearchResult {
  docIndex: number;
  score: number;
}

interface PostingList {
  docIds: Uint32Array;
  lastQueryEpoch: number;
  length: number;
  termFrequencies: Uint32Array;
}

const LATIN_COMBINING_MARKS = /(\p{Script=Latin})\p{M}+/gu;
const HAS_NON_ASCII = /[^\p{ASCII}]/u;
const INITIAL_DOCUMENT_CAPACITY = 16;
const INITIAL_POSTING_CAPACITY = 1;

/**
 * Reads a slot whose bound is guaranteed by this file's own capacity arithmetic
 * (`ensureDocumentCapacity`, `ensureHeapCapacity`, `PostingList.length`).
 *
 * `noUncheckedIndexedAccess` widens every typed-array read to `number |
 * undefined`. Scoring reads several slots per posting per query, so the check
 * lives here, once, instead of at every call site. It throws rather than
 * substituting a default: an out-of-bounds read means the capacity arithmetic
 * is wrong, and a default would hide that behind a silently wrong score.
 */
function elementAt(array: Float64Array | Uint32Array, index: number): number {
  const value = array[index];
  if (value === undefined) {
    throw new RangeError(`BM25 read index ${String(index)} outside the allocated range.`);
  }
  return value;
}

function normalizeText(text: string, hasNonAscii: boolean): string {
  const lower = text.toLowerCase();
  if (!hasNonAscii) return lower;
  return lower.normalize("NFD").replace(LATIN_COMBINING_MARKS, "$1");
}

function createPostingList(): PostingList {
  return {
    docIds: new Uint32Array(INITIAL_POSTING_CAPACITY),
    lastQueryEpoch: 0,
    length: 0,
    termFrequencies: new Uint32Array(INITIAL_POSTING_CAPACITY),
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

class BM25 {
  private readonly asciiTokenPattern = /[a-z0-9]+/g;
  private readonly b: number;
  private readonly k1: number;
  private readonly k1PlusOne: number;
  private readonly normalizationOffset: number;
  private readonly tokenizer?: BM25Tokenizer;
  private readonly unicodeTokenPattern = /[\p{L}\p{M}\p{N}]+/gu;

  private readonly queryPostings: PostingList[] = [];
  private readonly terms = new Map<string, PostingList>();

  private docLengths = new Uint32Array(0);
  private heapDocIndexes = new Uint32Array(0);
  private heapScores = new Float64Array(0);
  private scoreEpochs = new Uint32Array(0);
  private scores = new Float64Array(0);
  private touchedDocs = new Uint32Array(0);

  private currentEpoch = 0;
  private documentCountValue = 0;
  private totalDocumentLength = 0;

  constructor(corpus: readonly string[] = [], options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.tokenizer = options.tokenizer;

    if (!Number.isFinite(this.k1) || this.k1 < 0) {
      throw new RangeError("k1 must be a finite number greater than or equal to 0");
    }
    if (!Number.isFinite(this.b) || this.b < 0 || this.b > 1) {
      throw new RangeError("b must be a finite number between 0 and 1");
    }

    this.k1PlusOne = this.k1 + 1;
    this.normalizationOffset = this.k1 * (1 - this.b);

    this.ensureDocumentCapacity(corpus.length);
    for (const document of corpus) this.addDocument(document);
  }

  public get documentCount(): number {
    return this.documentCountValue;
  }

  public addDocument(text: string): number {
    if (this.documentCountValue === 0xffffffff) {
      throw new RangeError("BM25 supports at most 4,294,967,295 documents");
    }

    const docIndex = this.documentCountValue;
    this.ensureDocumentCapacity(docIndex + 1);

    const frequencies = new Map<string, number>();
    let documentLength = 0;

    for (const term of this.tokenize(text)) {
      if (term.length === 0) continue;
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      documentLength++;
    }

    this.docLengths[docIndex] = documentLength;
    this.totalDocumentLength += documentLength;
    this.documentCountValue++;

    for (const [term, termFrequency] of frequencies) {
      let postings = this.terms.get(term);
      if (postings === undefined) {
        postings = createPostingList();
        this.terms.set(term, postings);
      }
      appendPosting(postings, docIndex, termFrequency);
    }

    return docIndex;
  }

  public addDocuments(documents: readonly string[]): number[] {
    const firstDocIndex = this.documentCountValue;
    this.ensureDocumentCapacity(firstDocIndex + documents.length);

    return documents.map((document) => this.addDocument(document));
  }

  public search(query: string, topK = 5): SearchResult[] {
    const limit = this.resolveLimit(topK);
    if (limit === 0) return [];

    const resultCount = this.rank(query, limit);
    if (resultCount === 0) return [];

    this.sortHeapDescending(resultCount);

    const results = new Array<SearchResult>(resultCount);
    for (let i = 0; i < resultCount; i++) {
      results[i] = {
        docIndex: elementAt(this.heapDocIndexes, i),
        score: elementAt(this.heapScores, i),
      };
    }
    return results;
  }

  public searchInto(
    query: string,
    docIndexes: Uint32Array,
    scores: Float64Array,
    topK = Math.min(docIndexes.length, scores.length),
  ): number {
    const limit = this.resolveLimit(topK);
    if (docIndexes.length < limit || scores.length < limit) {
      throw new RangeError("searchInto output buffers must have at least topK positions");
    }
    if (limit === 0) return 0;

    const resultCount = this.rank(query, limit);
    if (resultCount === 0) return 0;

    this.sortHeapDescending(resultCount);
    for (let i = 0; i < resultCount; i++) {
      docIndexes[i] = elementAt(this.heapDocIndexes, i);
      scores[i] = elementAt(this.heapScores, i);
    }
    return resultCount;
  }

  private ensureDocumentCapacity(required: number): void {
    if (required <= this.docLengths.length) return;

    let capacity = Math.max(INITIAL_DOCUMENT_CAPACITY, this.docLengths.length);
    while (capacity < required) capacity *= 2;

    const docLengths = new Uint32Array(capacity);
    docLengths.set(this.docLengths);

    this.docLengths = docLengths;
    this.scores = new Float64Array(capacity);
    this.scoreEpochs = new Uint32Array(capacity);
    this.touchedDocs = new Uint32Array(capacity);
  }

  private ensureHeapCapacity(required: number): void {
    if (required <= this.heapDocIndexes.length) return;

    let capacity = Math.max(8, this.heapDocIndexes.length);
    while (capacity < required) capacity *= 2;

    this.heapDocIndexes = new Uint32Array(capacity);
    this.heapScores = new Float64Array(capacity);
  }

  private isHeapEntryWorse(a: number, b: number): boolean {
    const aScore = elementAt(this.heapScores, a);
    const bScore = elementAt(this.heapScores, b);
    return (
      aScore < bScore ||
      (aScore === bScore && elementAt(this.heapDocIndexes, a) > elementAt(this.heapDocIndexes, b))
    );
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
    for (const term of this.tokenize(query)) {
      if (term.length === 0) continue;
      const postings = this.terms.get(term);
      if (postings === undefined || postings.lastQueryEpoch === epoch) continue;
      postings.lastQueryEpoch = epoch;
      this.queryPostings.push(postings);
    }

    if (this.queryPostings.length === 0) return 0;

    const normalizationScale =
      (this.k1 * this.b * this.documentCountValue) / this.totalDocumentLength;
    let touchedCount = 0;

    for (const postings of this.queryPostings) {
      const documentFrequency = postings.length;
      const idf = Math.log1p(
        (this.documentCountValue - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );
      const termScale = idf * this.k1PlusOne;

      const docIds = postings.docIds;
      const termFrequencies = postings.termFrequencies;
      for (let i = 0; i < documentFrequency; i++) {
        const docIndex = elementAt(docIds, i);
        const termFrequency = elementAt(termFrequencies, i);
        const contribution =
          (termScale * termFrequency) /
          (termFrequency +
            this.normalizationOffset +
            normalizationScale * elementAt(this.docLengths, docIndex));

        if (this.scoreEpochs[docIndex] !== epoch) {
          this.scoreEpochs[docIndex] = epoch;
          this.scores[docIndex] = contribution;
          this.touchedDocs[touchedCount++] = docIndex;
        } else {
          this.scores[docIndex] = elementAt(this.scores, docIndex) + contribution;
        }
      }
    }

    if (touchedCount === 0) return 0;

    this.ensureHeapCapacity(Math.min(limit, touchedCount));
    let heapLength = 0;

    for (let i = 0; i < touchedCount; i++) {
      const docIndex = elementAt(this.touchedDocs, i);
      const score = elementAt(this.scores, docIndex);

      if (heapLength < limit) {
        let position = heapLength++;
        while (position > 0) {
          const parent = (position - 1) >>> 1;
          const parentScore = elementAt(this.heapScores, parent);
          const parentDocIndex = elementAt(this.heapDocIndexes, parent);
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

      const worstScore = elementAt(this.heapScores, 0);
      const worstDocIndex = elementAt(this.heapDocIndexes, 0);
      const candidateIsBetter =
        score > worstScore || (score === worstScore && docIndex < worstDocIndex);
      if (!candidateIsBetter) continue;

      let position = 0;
      for (;;) {
        const left = position * 2 + 1;
        if (left >= heapLength) break;

        const right = left + 1;
        let worseChild = left;
        if (right < heapLength && this.isHeapEntryWorse(right, left)) worseChild = right;

        const childScore = elementAt(this.heapScores, worseChild);
        const childDocIndex = elementAt(this.heapDocIndexes, worseChild);
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

  private resolveLimit(topK: number): number {
    if (this.documentCountValue === 0 || !(topK > 0)) return 0;
    return Math.min(this.documentCountValue, Math.floor(topK));
  }

  private sortHeapDescending(length: number): void {
    for (let end = length - 1; end > 0; end--) {
      const rootScore = elementAt(this.heapScores, 0);
      const rootDocIndex = elementAt(this.heapDocIndexes, 0);
      const replacementScore = elementAt(this.heapScores, end);
      const replacementDocIndex = elementAt(this.heapDocIndexes, end);

      this.heapScores[end] = rootScore;
      this.heapDocIndexes[end] = rootDocIndex;

      let position = 0;
      for (;;) {
        const left = position * 2 + 1;
        if (left >= end) break;

        const right = left + 1;
        let worseChild = left;
        if (right < end && this.isHeapEntryWorse(right, left)) worseChild = right;

        const childScore = elementAt(this.heapScores, worseChild);
        const childDocIndex = elementAt(this.heapDocIndexes, worseChild);
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

  private *tokenize(text: string): Generator<string> {
    if (this.tokenizer !== undefined) {
      yield* this.tokenizer(text);
      return;
    }

    const hasNonAscii = HAS_NON_ASCII.test(text);
    const normalized = normalizeText(text, hasNonAscii);
    const tokenPattern = hasNonAscii ? this.unicodeTokenPattern : this.asciiTokenPattern;
    tokenPattern.lastIndex = 0;

    let match = tokenPattern.exec(normalized);
    while (match !== null) {
      yield match[0];
      match = tokenPattern.exec(normalized);
    }
  }
}

export { BM25 };

export type { BM25Options, BM25Tokenizer, SearchResult };
