interface BM25Options {
  k1?: number;
  b?: number;
}

interface SearchResult {
  docIndex: number;
  score: number;
}

class BM25 {
  private k1: number;
  private b: number;

  private docs: string[][] = [];
  private docLengths: number[] = [];
  private avgDocLength = 0;

  private termFreqs = new Map<string, Map<number, number>>();
  private idf = new Map<string, number>();

  constructor(corpus: string[], options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.buildIndex(corpus);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9ñ]+/)
      .filter(Boolean);
  }

  private buildIndex(corpus: string[]): void {
    for (const text of corpus) {
      const tokens = this.tokenize(text);
      const docIndex = this.docs.length;
      this.docs.push(tokens);
      this.docLengths.push(tokens.length);

      for (const token of tokens) {
        let postings = this.termFreqs.get(token);
        if (!postings) {
          postings = new Map();
          this.termFreqs.set(token, postings);
        }
        postings.set(docIndex, (postings.get(docIndex) ?? 0) + 1);
      }
    }

    const N = this.docs.length;
    this.avgDocLength = this.docLengths.reduce((sum, len) => sum + len, 0) / (N || 1);

    for (const [term, postings] of this.termFreqs) {
      const n = postings.size;
      this.idf.set(term, Math.log((N - n + 0.5) / (n + 0.5) + 1));
    }
  }

  private scoreDoc(docIndex: number, queryTokens: string[]): number {
    const docLen = this.docLengths[docIndex]!;
    const lengthNorm =
      1 - this.b + this.b * (docLen / this.avgDocLength);

    let score = 0;
    for (const term of queryTokens) {
      const postings = this.termFreqs.get(term);
      const tf = postings?.get(docIndex) ?? 0;
      if (tf === 0) continue;

      const idf = this.idf.get(term) ?? 0;
      score += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * lengthNorm);
    }
    return score;
  }

  search(query: string, topK = 10): SearchResult[] {
    const queryTokens = this.tokenize(query);

    const candidates = new Set<number>();
    for (const term of queryTokens) {
      const postings = this.termFreqs.get(term);
      if (postings) {
        for (const docIndex of postings.keys()) candidates.add(docIndex);
      }
    }

    const results: SearchResult[] = [];
    for (const docIndex of candidates) {
      const score = this.scoreDoc(docIndex, queryTokens);
      if (score > 0) results.push({ docIndex, score });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

export {
  BM25
};