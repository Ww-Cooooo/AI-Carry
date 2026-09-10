const fileUri = /file:\/\//iu;
const remoteWebUrl = /https?:\/\/[^\s<>"'`]+/giu;
const windowsAbsolute = /(?:[a-z]:[\\/]|\\\\(?:\?\\|\.\\|[^\\\s<>"'`]+\\[^\\\s<>"'`]+))/iu;
const windowsNtNamespace = /(?:\\\\\?\\|\\\\\.\\|\\\?\?\\|\\(?:Device|GLOBALROOT)\\)/iu;
const windowsRootRelative = /(?:^|[\s"'`([{：:])\\(?![\\?.])(?:[^\\/\s\r\n<>"'`:]+\\[^\r\n<>"'`]+|[^\\/\s\r\n<>"'`:]*\.[A-Za-z0-9_-]{1,16})(?=$|[\s"'`)\]}，。！？；;,!?])/iu;
const windowsDriveRelative = /(?:^|[\s"'`([{：:])[a-z]:(?![\\/\s])[^\\/\s\r\n<>"'`]+(?:[\\/][^\r\n<>"'`]+)*/iu;
const percentEnvironmentRoot = /%(?:USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|PROGRAMDATA|SYSTEMROOT|CD)%[\\/]/iu;
const dollarEnvironmentRoot = /\$(?:env:)?(?:\{(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|PWD|OLDPWD)\}|(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|PWD|OLDPWD))[\\/]/iu;
const protocolRelativeShare = /\/\/[^/\s<>"'`]+\/[^/\s<>"'`]+/gu;
const posixDeviceRoot = /\/(?:home|Users|etc|var|tmp|opt|root|mnt|media|Volumes|data|workspace|project|app|usr|srv|run|private|secrets?|credentials?|Library|Applications|System)(?:\/[A-Za-z0-9._~+@%=-]+)+/gu;
const posixAbsoluteFile = /(?:^|[\s"'`([{：:])\/(?!\/)(?:[A-Za-z0-9._~+@%=-]+\/)*[A-Za-z0-9._~+@%=-]+\.[A-Za-z0-9_-]{1,16}(?=$|[\s"'`)\]}，。！？；;,!?])/gu;
const tildeHome = /~\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~+@%=-]+)*/u;
const forbiddenKeys = new Set(["path", "target", "source_ref", "repository"]);
// A device-root-looking segment inside an explicit ./ or ../ reference is
// still relative text. This does not authorize following it: the file reader
// continues to enforce the resolved root, links and the caller's read scope.
const dotRelativePrefix = /(?:^|[\s"'`([{<：:])\.\.?(?:\/[^/\\\s<>"'`(){}\[\]：:;,，；。!?！？]+)*$/u;

export function containsForbiddenLocationReference(value) {
  if (typeof value !== "string") return false;
  if (fileUri.test(value)) return true;
  // Remove normal remote URLs before local-path scanning. This avoids treating
  // a remote `/home/...` route as a device path while still catching paths
  // directly adjacent to Chinese or English prose, JSON and Markdown wrappers.
  const inspected = value.replace(remoteWebUrl, (match) => " ".repeat(match.length));
  if (windowsAbsolute.test(inspected) || windowsNtNamespace.test(inspected)
    || windowsRootRelative.test(inspected) || windowsDriveRelative.test(inspected)
    || percentEnvironmentRoot.test(inspected) || dollarEnvironmentRoot.test(inspected)
    || tildeHome.test(inspected)) return true;
  protocolRelativeShare.lastIndex = 0;
  for (const _match of inspected.matchAll(protocolRelativeShare)) return true;
  posixDeviceRoot.lastIndex = 0;
  for (const match of inspected.matchAll(posixDeviceRoot)) {
    if (!dotRelativePrefix.test(inspected.slice(0, match.index))) return true;
  }
  posixAbsoluteFile.lastIndex = 0;
  for (const _match of inspected.matchAll(posixAbsoluteFile)) return true;
  return false;
}

// Structured metadata may contain validated private_refs locators. Those
// locators are checked by their owning schema and must never be copied to a
// model-visible projection; skipping only this exact field prevents a valid
// private:// locator from being mistaken for a protocol-relative UNC share
// while still rejecting the same text in titles, summaries or bodies.
export function containsForbiddenStructuredLocation(value) {
  if (typeof value === "string") return containsForbiddenLocationReference(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenStructuredLocation);
  return Object.entries(value).some(([key, item]) => key !== "private_refs" && containsForbiddenStructuredLocation(item));
}

export function assertLocationFreeProjection(value) {
  if (containsForbiddenLocationReference(value)) throw new Error("unsafe-output");
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertLocationFreeProjection(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error("unsafe-output");
    assertLocationFreeProjection(item);
  }
}
