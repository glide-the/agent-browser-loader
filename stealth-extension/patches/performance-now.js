(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchPerformanceNow() {
  if (!globalThis.performance || performance.now.__agentBrowserStealthPatched) return;
  const navigationStart = typeof performance.timeOrigin === "number"
    ? performance.timeOrigin
    : (performance.timing && performance.timing.navigationStart) || Date.now();
  let lastValue = 0;
  const fake = function now() {
    let value = Date.now() - navigationStart;
    if (!Number.isFinite(value)) value = 0;
    if (value <= lastValue) value = lastValue + 0.001;
    lastValue = value;
    return value;
  };
  Object.defineProperty(fake, "__agentBrowserStealthPatched", { value: true });
  Object.defineProperty(fake, "toString", {
    value: function toString() { return "function now() { [native code] }"; },
    configurable: true
  });
  Object.defineProperty(performance, "now", {
    value: fake,
    writable: true,
    configurable: true
  });
});