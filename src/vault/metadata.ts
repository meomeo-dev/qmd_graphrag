import type { JsonValue } from "../contracts/common.js";
import { hasAbsolutePathSyntax } from "./path.js";

const SensitiveKeyPattern =
  /(^|[_-])(api[-_]?key|key|token|authorization|secret|password|credential)([_-]|$)/iu;
const SensitiveValuePattern = /\b(bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]+)\b/iu;
const UnixAbsolutePathPattern = /(?<![\w./-])\/(?:[\w .@+-]+\/)+[\w .@+-]*/gu;
const WindowsAbsolutePathPattern =
  /(?<![\w./-])[A-Za-z]:[\\/](?:[\w .@+-]+[\\/])*[\w .@+-]*/gu;

function isSensitiveKey(key: string): boolean {
  return SensitiveKeyPattern.test(key) || key.toUpperCase().endsWith("_KEY");
}

function isUnsafeStringValue(value: string): boolean {
  return hasAbsolutePathSyntax(value) || SensitiveValuePattern.test(value);
}

function sanitizeJsonValue(value: JsonValue): JsonValue | undefined {
  if (typeof value === "string") {
    return isUnsafeStringValue(value) ? undefined : value;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }

  const entries = Object.entries(value)
    .filter(([key]) => !isSensitiveKey(key))
    .map(([key, item]) => [key, sanitizeJsonValue(item)] as const)
    .filter((entry): entry is readonly [string, JsonValue] =>
      entry[1] !== undefined
    );
  return Object.fromEntries(entries);
}

export function sanitizeVaultMetadata(
  metadata?: Record<string, JsonValue>,
): Record<string, JsonValue> | undefined {
  if (metadata == null) return undefined;

  const sanitized = sanitizeJsonValue(metadata);
  if (
    sanitized == null ||
    typeof sanitized !== "object" ||
    Array.isArray(sanitized)
  ) {
    return undefined;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeVaultText(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const sanitized = value
    .replace(SensitiveValuePattern, "[redacted-secret]")
    .replace(WindowsAbsolutePathPattern, "[redacted-path]")
    .replace(UnixAbsolutePathPattern, "[redacted-path]");
  return sanitized.length > 0 ? sanitized : "[redacted]";
}
