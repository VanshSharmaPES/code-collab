import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Hide the on-screen dev indicator (the Next.js badge) during `npm run dev`; compile and runtime errors still show.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  // Native ONNX runtime and model loader used by the semantic search; they must not be bundled.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "onnxruntime-web", "sharp"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
