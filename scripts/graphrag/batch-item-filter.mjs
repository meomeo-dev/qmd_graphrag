export function parseBookIdFilter(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length === 0 ? null : new Set(ids);
}

export function filterItemsByBookId(items, includeBookIds) {
  if (includeBookIds == null) return items;
  return items.filter((item) => includeBookIds.has(item.bookId));
}
