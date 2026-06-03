import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { validateBookHotplugPackage } from "./book-hotplug-package.mjs";
import {
  writeHotplugJsonWithSidecars,
} from "./book-hotplug-json-sidecars.mjs";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function linkPackageRoots(bookRoot, candidateRoot) {
  for (const name of ["source", "input", "qmd", "graphrag", "state", "metadata"]) {
    const source = join(bookRoot, name);
    if (!existsSync(source)) continue;
    symlinkSync(source, join(candidateRoot, name), "dir");
  }
}

export function validateHotplugPackagePublishCandidate(input) {
  const stateRoot = resolve(input.stateRoot);
  const bookRoot = resolve(stateRoot, "books", input.bookId);
  const stagingBase = input.stagingRoot ??
    join(stateRoot, ".staging", "hotplug-publish-gate");
  const candidateRoot = join(
    stagingBase,
    `${input.bookId}-${randomUUID().replace(/-/gu, "")}`,
  );
  mkdirSync(candidateRoot, { recursive: true });
  try {
    linkPackageRoots(bookRoot, candidateRoot);
    writeHotplugJsonWithSidecars(
      join(candidateRoot, "BOOK_MANIFEST.json"),
      input.manifest,
      {
        rootPath: stateRoot,
        runnerSessionId: "book-hotplug-publish-candidate",
      },
    );
    writeHotplugJsonWithSidecars(
      join(candidateRoot, "PUBLISH_READY.json"),
      input.publishReady,
      {
        rootPath: stateRoot,
        runnerSessionId: "book-hotplug-publish-candidate",
      },
    );
    return {
      ...validateBookHotplugPackage({ bookRoot: candidateRoot }),
      candidateRoot: toPosixPath(relative(stateRoot, candidateRoot)),
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        `publish_candidate_validation_error:${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      candidateRoot: toPosixPath(relative(stateRoot, candidateRoot)),
    };
  } finally {
    if (input.retainCandidate !== true) {
      rmSync(candidateRoot, { recursive: true, force: true });
    }
  }
}
