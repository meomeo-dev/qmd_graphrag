import { basename } from "node:path";

export const qmdIndexWriterCommandCheckNames = Object.freeze([
  "qmd-pull",
  "qmd-update",
  "qmd-embed",
  "qmd-cleanup",
]);

export const qmdMultiGetMaxBytes = "4096";
export const qmdValidationOutputMaxBufferBytes = 1024 * 1024;

export function qmdIndexLockedCommandNamesFor(requiredCommandCheckNames) {
  const required = new Set(requiredCommandCheckNames);
  return new Set(qmdIndexWriterCommandCheckNames.filter((name) => required.has(name)));
}

export function qmdMultiGetJsonArgsForNormalizedPath(normalizedPath) {
  return [
    "multi-get",
    `qmd://books/${basename(normalizedPath)}`,
    "-l",
    "1",
    "--max-bytes",
    qmdMultiGetMaxBytes,
    "--json",
  ];
}
