import type { Article } from "../types.js";

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Local ONNX embeddings via transformers.js — no API cost, no rate limit.
 * The model is multilingual on purpose: English wire copy and Korean coverage
 * of the same event have to land near each other (docs/DESIGN.md §5.1).
 *
 * First call downloads the model (~120MB) to ./.cache and needs network;
 * every run after that is offline.
 */
export async function createLocalEmbedder(modelId: string): Promise<Embedder> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = "./.cache";
  const extractor = await pipeline("feature-extraction", modelId);

  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      // e5-family models expect this prefix on both sides of the comparison.
      const prefixed = texts.map((t) => `query: ${t}`);
      const out = await extractor(prefixed, { pooling: "mean", normalize: true });
      const dims = out.dims as number[];
      const width = dims[dims.length - 1]!;
      const flat = Float32Array.from(out.data as ArrayLike<number>);
      return texts.map((_, i) => flat.slice(i * width, (i + 1) * width));
    },
  };
}

/** Text handed to the embedder. Title carries most of the signal; the lede disambiguates. */
export function embeddingText(a: Article): string {
  return a.snippet ? `${a.title}. ${a.snippet.slice(0, 400)}` : a.title;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function centroid(vectors: Float32Array[]): Float32Array {
  const width = vectors[0]?.length ?? 0;
  const out = new Float32Array(width);
  for (const v of vectors) for (let i = 0; i < width; i++) out[i] = out[i]! + v[i]!;
  const n = vectors.length || 1;
  for (let i = 0; i < width; i++) out[i] = out[i]! / n;
  return out;
}
