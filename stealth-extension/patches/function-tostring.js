(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchFunctionToString() {
  const original = Function.prototype.toString;
  if (original.__agentBrowserStealthPatched) return;
  const replacement = function toString() {
    if (typeof this === "function" && this.__agentBrowserNativeSource) {
      return this.__agentBrowserNativeSource;
    }
    return original.call(this);
  };
  Object.defineProperty(replacement, "__agentBrowserStealthPatched", { value: true });
  Object.defineProperty(Function.prototype, "toString", {
    value: replacement,
    writable: true,
    configurable: true
  });
});