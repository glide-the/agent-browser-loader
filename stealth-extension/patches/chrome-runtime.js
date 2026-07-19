(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchChromeRuntime() {
  if (!globalThis.chrome || "runtime" in globalThis.chrome) return;
  const nativeFunction = function(name) {
    const fn = function() {};
    Object.defineProperty(fn, "toString", {
      value: function toString() { return `function ${name}() { [native code] }`; },
      configurable: true
    });
    return fn;
  };
  Object.defineProperty(globalThis.chrome, "runtime", {
    value: {
      get id() { return undefined; },
      connect: nativeFunction("connect"),
      sendMessage: nativeFunction("sendMessage")
    },
    writable: true,
    enumerable: true,
    configurable: true
  });
});