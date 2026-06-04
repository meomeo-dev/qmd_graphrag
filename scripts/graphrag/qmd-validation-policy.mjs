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

export function qmdBooksUriForNormalizedPath(normalizedPath) {
  const normalized = String(normalizedPath).replaceAll("\\", "/");
  const match = /(?:^|\/)books\/([^/]+)\/input\/([^/]+)$/u.exec(normalized);
  if (match != null) {
    return `qmd://books/${match[1]}/input/${match[2]}`;
  }
  throw new Error(
    `normalized path must use books/{bookId}/input/{file}: ${normalized}`,
  );
}

export function qmdMultiGetJsonArgsForNormalizedPath(normalizedPath) {
  return [
    "multi-get",
    qmdBooksUriForNormalizedPath(normalizedPath),
    "-l",
    "1",
    "--max-bytes",
    qmdMultiGetMaxBytes,
    "--json",
  ];
}
