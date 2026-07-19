(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchHeadlessUA() {
  if (!navigator.userAgent || !navigator.userAgent.includes("HeadlessChrome/")) return;
  const proto = Object.getPrototypeOf(navigator);
  const cleanUA = navigator.userAgent.replace("HeadlessChrome/", "Chrome/");
  const cleanAppVersion = navigator.appVersion
    ? navigator.appVersion.replace("HeadlessChrome/", "Chrome/")
    : "";
  Object.defineProperty(proto, "userAgent", {
    get: function userAgent() { return cleanUA; },
    configurable: true
  });
  if (cleanAppVersion) {
    Object.defineProperty(proto, "appVersion", {
      get: function appVersion() { return cleanAppVersion; },
      configurable: true
    });
  }
});