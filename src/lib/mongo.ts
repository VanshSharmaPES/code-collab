import "server-only";
import { MongoClient, type Db } from "mongodb";
import { parseWebMongoUrl } from "@/lib/mongo-url";

// Cache the client on globalThis so dev hot reloads reuse one connection pool.
const globalForMongo = globalThis as unknown as { mongoClient?: MongoClient };

// Created lazily so builds and imports do not require MONGO_URL. It connects to the server MONGO_URL names, in
// production too; the local-only guard of mongo-config.ts is for the maintenance scripts (see mongo-url.ts).
export function getMongoDb(): Db {
  const target = parseWebMongoUrl(process.env.MONGO_URL);
  globalForMongo.mongoClient ??= new MongoClient(target.url, { serverSelectionTimeoutMS: 5000 });
  return globalForMongo.mongoClient.db(target.database);
}
