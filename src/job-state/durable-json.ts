import {
  DurableStateError,
  durableChecksumPath,
  readJsonFileDurable,
  reconcileDurableTextFile,
  writeJsonFileDurable,
} from "./durable-state-store.js";

export const durableJsonChecksumPath = durableChecksumPath;

export {
  DurableStateError,
  readJsonFileDurable,
  writeJsonFileDurable,
};

export async function reconcileDurableJsonFile(path: string): Promise<void> {
  await reconcileDurableTextFile(path, "json");
}
