import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// WHY: task 1 ships a valid but inert extension so the package installs and
// loads safely before configuration handling and dispatch exist.
export default function (_pi: ExtensionAPI): void {}
