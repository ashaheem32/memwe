# Latency budget

Sub-300ms is a budget, not an aspiration.

## Retrieval

### Dense

Twelve milliseconds against the memories index.

### Lexical

BM25 over tsvector, eight milliseconds.

## Reranking

Adds about ninety milliseconds. Optional per request.

```ts
const score = rrf * salience * (0.7 + 0.6 * utility)
```
