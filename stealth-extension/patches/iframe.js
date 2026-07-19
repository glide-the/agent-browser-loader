(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchIframe() {
  const original = Document.prototype.createElement;
  if (!original || original.__agentBrowserStealthPatched) return;
  const replacement = function createElement(tagName) {
    const element = original.apply(this, arguments);
    if (String(tagName).toLowerCase() !== "iframe") return element;
    try {
      const initialSrcdoc = element.srcdoc;
      Object.defineProperty(element, "srcdoc", {
        configurable: true,
        get: function() { return initialSrcdoc; },
        set: function(value) {
          if (!element.contentWindow) {
            const proxy = new Proxy(globalThis, {
              get: function(target, key) {
                if (key === "self") return proxy;
                if (key === "frameElement") return element;
                if (key === "0") return undefined;
                return Reflect.get(target, key);
              }
            });
            Object.defineProperty(element, "contentWindow", {
              get: function() { return proxy; },
              configurable: false
            });
          }
          Object.defineProperty(element, "srcdoc", {
            value,
            writable: true,
            configurable: true
          });
        }
      });
    } catch (_) {}
    return element;
  };
  Object.defineProperty(replacement, "__agentBrowserStealthPatched", { value: true });
  Document.prototype.createElement = replacement;
});