// Pure shared selection for the host bundle, developer tools and UI fixtures.
export const REMOTE_PAYLOAD_PARTS = new Set(["13r-remote-transport.js", "13s-remote-view.js", "13t-remote-settings.js"]);
export const isCoreAppPart = (name) => name.endsWith(".js") && !REMOTE_PAYLOAD_PARTS.has(name);
