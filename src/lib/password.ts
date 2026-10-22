import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

// Argon2id is the library default. Parameters match the dev seed hashes (m=64 MiB, t=3, p=4);
// verify() reads the parameters from each stored hash, so older hashes keep working.
const HASH_OPTIONS = { memoryCost: 65536, timeCost: 3, parallelism: 4 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

// A malformed stored hash counts as a mismatch instead of throwing.
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

// Verified against when the account does not exist, so "unknown email" costs about as
// much time as "wrong password". Built once from random bytes, never from a real password.
let dummyHash: Promise<string> | undefined;

export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  await verifyPassword(await dummyHash, password);
}
