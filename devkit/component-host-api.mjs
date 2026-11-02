export function componentHostApiFields(component) {
  if (!Object.hasOwn(component, "hostApi")) return {};
  const api = component.hostApi;
  if (!api || typeof api !== "object" || Array.isArray(api) || Object.keys(api).length !== 1
      || !Number.isSafeInteger(api.remoteSession) || api.remoteSession < 1) {
    throw new Error("hostApi must be { remoteSession: positive integer }");
  }
  return { hostApi: { remoteSession: api.remoteSession } };
}
