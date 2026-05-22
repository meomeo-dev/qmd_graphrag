import { isAbsolute, relative, resolve, win32 } from "node:path";

const WindowsDrivePrefix = /^[A-Za-z]:/u;
const UriLikePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export function hasAbsolutePathSyntax(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path) || WindowsDrivePrefix.test(path);
}

export function normalizePortableVaultRelativePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    hasAbsolutePathSyntax(path) ||
    UriLikePrefix.test(path)
  ) {
    throw new Error(`path must be vault-relative and portable: ${path}`);
  }

  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");

  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new Error(`path must be vault-relative and portable: ${path}`);
  }

  return parts.join("/");
}

export function isPortableVaultRelativePath(path: string): boolean {
  try {
    normalizePortableVaultRelativePath(path);
    return true;
  } catch {
    return false;
  }
}

export function resolveVaultRelativePath(
  graphVault: string,
  path: string,
): string | null {
  let portablePath: string;
  try {
    portablePath = normalizePortableVaultRelativePath(path);
  } catch {
    return null;
  }

  const root = resolve(graphVault);
  const resolvedPath = resolve(root, portablePath);
  const relativePath = relative(root, resolvedPath);
  if (relativePath.startsWith("..") || hasAbsolutePathSyntax(relativePath)) {
    return null;
  }

  return resolvedPath;
}
