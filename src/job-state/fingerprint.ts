import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

type StableJson =
  | null
  | boolean
  | number
  | string
  | StableJson[]
  | { [key: string]: StableJson };

function normalizeForStableHash(input: unknown): StableJson {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "number" ||
    typeof input === "string"
  ) {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => normalizeForStableHash(item));
  }

  if (input instanceof Date) {
    return input.toISOString();
  }

  if (typeof input === "object" && input != null) {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalizeForStableHash(value)]);

    return Object.fromEntries(entries);
  }

  return String(input);
}

export function createDeterministicHash(input: unknown): string {
  const payload = JSON.stringify(normalizeForStableHash(input));
  return createHash("sha256").update(payload).digest("hex");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function hashFile(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}

export function normalizeBookSlug(sourcePath: string): string {
  const name = basename(sourcePath)
    .replace(/\.(epub|md|markdown|txt)$/iu, "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return name || "book";
}

export function buildBookId(sourcePath: string): string {
  const pathHash = createHash("sha256")
    .update(sourcePath.normalize("NFKC").toLowerCase())
    .digest("hex");
  return `${normalizeBookSlug(sourcePath)}-${pathHash.slice(0, 12)}`;
}

export function buildBookIdFromSourceHash(
  sourcePath: string,
  sourceHash: string,
): string {
  return `${normalizeBookSlug(sourcePath)}-${sourceHash.slice(0, 12)}`;
}

export function createRunId(stage: string, now: Date = new Date()): string {
  const prefix = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stage}-${prefix}-${suffix}`;
}

export function toIsoTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}
