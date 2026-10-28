import "server-only";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { MODEL_NAME, type Embedder } from "@/lib/embedding-model";

// The model is loaded once per process (about 25 MB, a few seconds the first time; it is downloaded on first use and
// then cached on disk). A failed load is not remembered, so the next request tries again.
const globalForModel = globalThis as unknown as { embeddingExtractor?: Promise<FeatureExtractionPipeline> };

function extractor(): Promise<FeatureExtractionPipeline> {
  globalForModel.embeddingExtractor ??= pipeline("feature-extraction", MODEL_NAME, { dtype: "q8" }).catch((err: unknown) => {
    globalForModel.embeddingExtractor = undefined;
    throw err;
  });
  return globalForModel.embeddingExtractor;
}

export const embedTexts: Embedder = async (texts) => {
  const output = await (await extractor())(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
};
