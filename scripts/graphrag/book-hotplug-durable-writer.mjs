import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, sep } from "node:path";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function fsyncFile(path) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function fsyncDirectory(path, operation = {}) {
  let fd = null;
  try {
    maybeInjectDirectoryFsyncFailure(path, operation);
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const wrapped = new Error(`hotplug durable directory fsync failed: ${path}`);
    wrapped.code = error?.code ?? "unknown";
    wrapped.cause = error;
    wrapped.localFailureClass = "hotplug_durable_directory_fsync_uncertain";
    wrapped.evidence = {
      ...operation,
      fsyncTarget: toPosixPath(path),
      fsyncErrno: wrapped.code,
      fsyncPlatform: process.platform,
    };
    throw wrapped;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function maybeInjectDirectoryFsyncFailure(path, operation) {
  if (process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS !== "1") return;
  const pattern = process.env
    .QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN ?? "";
  const candidates = [
    path,
    operation.path,
    operation.targetLocator,
    operation.operationId,
  ].filter((value) => typeof value === "string");
  if (pattern === "" || !candidates.some((value) => value.includes(pattern))) {
    return;
  }
  const error = new Error("injected hotplug directory fsync failure");
  error.code = "EIO";
  throw error;
}

export function writeHotplugTextAtomic(path, text, options = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const operation = {
    operationId: options.operationId ?? `hotplug-durable-${process.pid}`,
    runnerSessionId: options.runnerSessionId ?? "book-hotplug-durable-writer",
    path: toPosixPath(path),
    targetLocator: options.targetLocator,
  };
  const tempPath = `${path}.tmp-${operation.operationId}-${
    Math.random().toString(36).slice(2)
  }`;
  let renamed = false;
  try {
    writeFileSync(tempPath, text, { encoding: "utf8", flag: "wx" });
    fsyncFile(tempPath);
    renameSync(tempPath, path);
    renamed = true;
    fsyncDirectory(dirname(path), operation);
  } catch (error) {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
    if (renamed && options.removeTargetOnFsyncFailure === true) {
      rmSync(path, { force: true });
      try {
        fsyncDirectory(dirname(path), {
          ...operation,
          operationId: `${operation.operationId}-rollback`,
        });
      } catch {
        // The original fsync failure remains the authoritative failure.
      }
    }
    throw error;
  }
}
