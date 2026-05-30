export type DurableAuxiliarySidecarKind =
  | "corrupt_quarantine"
  | "lock"
  | "temp"
  | "temp_owner";

export type DurableChecksumSidecarKind = "checksum" | "checksum_meta";

export interface DurableTargetNormalization {
  targetLocator: string;
  primaryTargetLocator: string;
  isAuxiliary: boolean;
  auxiliaryTargetLocator?: string;
  auxiliarySidecarKind?: DurableAuxiliarySidecarKind;
  sidecarTargetLocator?: string;
  sidecarKind?: DurableChecksumSidecarKind;
}

export function normalizeDurableTargetForMapping(
  locator: string,
): DurableTargetNormalization {
  const targetLocator = locator.split("\\").join("/");
  let current = targetLocator;
  let auxiliaryTargetLocator: string | undefined;
  let auxiliarySidecarKind: DurableAuxiliarySidecarKind | undefined;
  let sidecarTargetLocator: string | undefined;
  let sidecarKind: DurableChecksumSidecarKind | undefined;

  for (;;) {
    const ownerStripped = stripTempOwnerSidecar(current);
    if (ownerStripped !== current) {
      auxiliaryTargetLocator ??= targetLocator;
      auxiliarySidecarKind ??= "temp_owner";
      current = ownerStripped;
      continue;
    }

    const tempStripped = stripBasenameMarker(current, ".tmp-");
    if (tempStripped !== current) {
      auxiliaryTargetLocator ??= targetLocator;
      auxiliarySidecarKind ??= "temp";
      current = tempStripped;
      continue;
    }

    const lockStripped = stripBasenameSuffix(current, ".lock");
    if (lockStripped !== current) {
      auxiliaryTargetLocator ??= targetLocator;
      auxiliarySidecarKind ??= "lock";
      current = lockStripped;
      continue;
    }

    const corruptStripped = stripBasenameMarker(current, ".corrupt-");
    if (corruptStripped !== current) {
      auxiliaryTargetLocator ??= targetLocator;
      auxiliarySidecarKind ??= "corrupt_quarantine";
      current = corruptStripped;
      continue;
    }

    const checksumMetaStripped = stripBasenameSuffix(
      current,
      ".sha256.meta.json",
    );
    if (checksumMetaStripped !== current) {
      sidecarTargetLocator ??= current;
      sidecarKind ??= "checksum_meta";
      current = checksumMetaStripped;
      continue;
    }

    const checksumStripped = stripBasenameSuffix(current, ".sha256");
    if (checksumStripped !== current) {
      sidecarTargetLocator ??= current;
      sidecarKind ??= "checksum";
      current = checksumStripped;
      continue;
    }

    break;
  }

  return {
    targetLocator,
    primaryTargetLocator: current,
    isAuxiliary: current !== targetLocator,
    auxiliaryTargetLocator,
    auxiliarySidecarKind,
    sidecarTargetLocator,
    sidecarKind,
  };
}

export function durableTargetNormalizationEvidence(
  normalization: DurableTargetNormalization,
): Record<string, unknown> {
  if (!normalization.isAuxiliary) return {};
  return {
    primaryTargetLocator: normalization.primaryTargetLocator,
    auxiliaryTargetLocator: normalization.auxiliaryTargetLocator,
    auxiliarySidecarKind: normalization.auxiliarySidecarKind,
    sidecarTargetLocator: normalization.sidecarTargetLocator,
    sidecarKind: normalization.sidecarKind,
  };
}

function stripTempOwnerSidecar(locator: string): string {
  if (!locator.endsWith(".owner.json")) return locator;
  if (basenameIndexOf(locator, ".tmp-") < 0) return locator;
  return locator.slice(0, -".owner.json".length);
}

function stripBasenameMarker(locator: string, marker: string): string {
  const index = basenameIndexOf(locator, marker);
  return index < 0 ? locator : locator.slice(0, index);
}

function stripBasenameSuffix(locator: string, suffix: string): string {
  const start = basenameStart(locator);
  if (!locator.endsWith(suffix)) return locator;
  if (locator.length - suffix.length < start) return locator;
  return locator.slice(0, -suffix.length);
}

function basenameIndexOf(locator: string, marker: string): number {
  return locator.indexOf(marker, basenameStart(locator));
}

function basenameStart(locator: string): number {
  return locator.lastIndexOf("/") + 1;
}
