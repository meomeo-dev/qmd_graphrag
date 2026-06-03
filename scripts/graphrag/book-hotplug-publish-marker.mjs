import { rmSync } from "node:fs";
import { join } from "node:path";

export function hotplugPublishMarkerPathForBookRoot(bookRoot) {
  return join(bookRoot, "PUBLISH_READY.json");
}

export function hotplugPublishMarkerPathsForBookRoot(bookRoot) {
  const publishReadyPath = hotplugPublishMarkerPathForBookRoot(bookRoot);
  return [
    publishReadyPath,
    `${publishReadyPath}.sha256`,
    `${publishReadyPath}.sha256.meta.json`,
  ];
}

export function removeHotplugPublishMarkerForBookRoot(bookRoot) {
  for (const path of hotplugPublishMarkerPathsForBookRoot(bookRoot)) {
    rmSync(path, { force: true });
  }
}
