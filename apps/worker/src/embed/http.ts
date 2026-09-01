import { MemweError } from "@memwe/contracts";
import {
  assertDimensions,
  EMBED_DIM,
  type EmbeddingProvider,
  type EmbedInput,
} from "./provider.js";

type HttpConfig = {
  id: string;
  url: string;
  apiKey: string;
  model: string;
  dimensions: number;
  maxBatchSize: number;
  maxBatchTokens: number;
  /** Providers that distinguish indexing from searching get better recall. */
  supportsInputType: boolean;
};

/**
 * One client for every OpenAI-shaped embeddings endpoint: OpenAI itself,
 * Voyage, Together, and a self-hosted TEI or vLLM server. They differ in
 * the base URL and whether they accept an input type, not in shape — so
 * the in-VPC deployment is a URL change rather than a second client.
 */
export class HttpEmbedding implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  readonly maxBatchTokens: number;
  readonly metered = true;

  constructor(private readonly cfg: HttpConfig) {
    this.id = cfg.id;
    this.dimensions = cfg.dimensions;
    this.maxBatchSize = cfg.maxBatchSize;
    this.maxBatchTokens = cfg.maxBatchTokens;
  }

  async embed(inputs: EmbedInput[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      input: inputs.map((i) => i.text),
    };
    if (this.cfg.supportsInputType) {
      // A batch is all one kind — the stage never mixes them.
      body["input_type"] = inputs[0]?.kind === "query" ? "query" : "document";
    }
    if (this.cfg.dimensions !== 0) body["dimensions"] = this.cfg.dimensions;

    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      // 429 and 5xx are worth retrying; a 400 means the request is wrong
      // and will be wrong again.
      const code =
        res.status === 429
          ? "rate_limited"
          : res.status >= 500
            ? "upstream_failed"
            : "invalid_request";
      throw new MemweError(code, `${this.id} embedding failed (${res.status}): ${detail}`, {
        status: res.status,
      });
    }

    const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = json.data ?? [];
    if (rows.length !== inputs.length) {
      throw new MemweError(
        "upstream_failed",
        `${this.id} returned ${rows.length} vectors for ${inputs.length} inputs`,
      );
    }

    // Order is not guaranteed by every provider; `index` is.
    const out: number[][] = new Array(inputs.length);
    rows.forEach((row, i) => {
      const at = row.index ?? i;
      out[at] = row.embedding ?? [];
    });
    assertDimensions(out, this.dimensions, this.id);
    return out;
  }
}

export function voyage(apiKey: string, model = "voyage-3-large"): HttpEmbedding {
  return new HttpEmbedding({
    id: `voyage:${model}`,
    url: "https://api.voyageai.com/v1/embeddings",
    apiKey,
    model,
    dimensions: EMBED_DIM,
    maxBatchSize: 128,
    maxBatchTokens: 120_000,
    supportsInputType: true,
  });
}

export function openAICompatible(
  apiKey: string,
  model: string,
  url: string,
  dimensions = EMBED_DIM,
): HttpEmbedding {
  return new HttpEmbedding({
    id: `openai:${model}`,
    url,
    apiKey,
    model,
    dimensions,
    maxBatchSize: 256,
    maxBatchTokens: 200_000,
    supportsInputType: false,
  });
}
