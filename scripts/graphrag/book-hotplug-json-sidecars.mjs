import { createHash } from "node:crypto";
import { relative, sep } from "node:path";

import { writeHotplugTextAtomic } from "./book-hotplug-durable-writer.mjs";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function nowDefault() {
  return new Date().toISOString();
}

export function writeHotplugJsonWithSidecars(path, value, options = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const checksum = sha256Text(text);
  const targetLocator = options.rootPath == null
    ? toPosixPath(path)
    : toPosixPath(relative(options.rootPath, path));
  const operationId = options.operationId ??
    `hotplug-publish-${sha256Text(path).slice(0, 16)}`;
  const runnerSessionId = options.runnerSessionId ??
    "book-hotplug-json-sidecars";
  writeHotplugTextAtomic(path, text, {
    operationId,
    runnerSessionId,
    targetLocator,
    removeTargetOnFsyncFailure: true,
  });
  writeHotplugTextAtomic(`${path}.sha256`, `${checksum}\n`, {
    operationId: `${operationId}-checksum`,
    runnerSessionId,
    targetLocator: `${targetLocator}.sha256`,
  });
  writeHotplugTextAtomic(
    `${path}.sha256.meta.json`,
    `${JSON.stringify({
      checksum,
      targetLocator,
      checksumPath: `${targetLocator}.sha256`,
      checksumRecoveryDecision: "committed",
      commitState: "committed",
      operationId,
      runnerSessionId,
      committedAt: options.committedAt ?? nowDefault(),
    }, null, 2)}\n`,
    {
      operationId: `${operationId}-meta`,
      runnerSessionId,
      targetLocator: `${targetLocator}.sha256.meta.json`,
    },
  );
  return { checksum, targetLocator };
}
