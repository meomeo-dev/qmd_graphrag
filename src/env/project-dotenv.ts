import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { findLocalConfigPath } from "../collections.js";

type DotenvMap = Record<string, string>;

function parseDotenvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const body = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed;
  const separatorIndex = body.indexOf("=");
  if (separatorIndex <= 0) return null;
  const key = body.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return null;

  let value = body.slice(separatorIndex + 1).trim();
  const quote = value[0];
  if (
    (quote === "\"" || quote === "'") &&
    value.endsWith(quote) &&
    value.length >= 2
  ) {
    value = value.slice(1, -1);
    if (quote === "\"") {
      value = value
        .replace(/\\n/gu, "\n")
        .replace(/\\r/gu, "\r")
        .replace(/\\t/gu, "\t")
        .replace(/\\"/gu, "\"")
        .replace(/\\\\/gu, "\\");
    }
  } else {
    const commentIndex = value.search(/\s#/u);
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
  }

  return { key, value };
}

export function projectDotenvPath(
  startDir: string,
): string | undefined {
  const localConfigPath = findLocalConfigPath(startDir);
  const projectDir = localConfigPath
    ? dirname(dirname(localConfigPath))
    : resolve(startDir);
  const dotenvPath = join(projectDir, ".env");
  return existsSync(dotenvPath) ? dotenvPath : undefined;
}

export function readProjectDotenv(
  startDir: string,
): DotenvMap {
  const dotenvPath = projectDotenvPath(startDir);
  if (dotenvPath == null) return {};

  const body = readFileSync(dotenvPath, "utf-8");
  const parsed: DotenvMap = {};
  for (const line of body.split(/\r?\n/u)) {
    const entry = parseDotenvLine(line);
    if (entry == null) continue;
    parsed[entry.key] = entry.value;
  }
  return parsed;
}

export function projectDotenvEnvOverlay(
  startDir: string,
  keys?: readonly string[],
): DotenvMap {
  const parsed = readProjectDotenv(startDir);
  if (keys == null) return parsed;
  return Object.fromEntries(
    keys
      .filter((key) => parsed[key] != null)
      .map((key) => [key, parsed[key]!]),
  );
}
