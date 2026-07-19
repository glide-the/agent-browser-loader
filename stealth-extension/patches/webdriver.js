(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchWebdriver() {
  const proto = Object.getPrototypeOf(navigator);
  const getter = function webdriver() { return undefined; };
  Object.defineProperty(getter, "__agentBrowserStealthPatched", { value: true });
  Object.defineProperty(proto, "webdriver", {
    get: getter,
    configurable: true
  });
});