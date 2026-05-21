import { fileURLToPath } from "node:url";

export function resolveProjectPath(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

