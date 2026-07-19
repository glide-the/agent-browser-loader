(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchConsoleTable() {
  if (!globalThis.console || console.table.__agentBrowserStealthPatched) return;
  const fake = function table() {};
  Object.defineProperty(fake, "__agentBrowserStealthPatched", { value: true });
  Object.defineProperty(fake, "toString", {
    value: function toString() { return "function table() { [native code] }"; },
    configurable: true
  });
  console.table = fake;
});