(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchWebGL() {
  const patchPrototype = function(proto) {
    if (!proto || !proto.getParameter || proto.getParameter.__agentBrowserStealthPatched) return;
    const original = proto.getParameter;
    const replacement = function getParameter(parameter) {
      const result = original.apply(this, arguments);
      if (parameter === 37445 && (!result || String(result).includes("Google"))) return "Intel Inc.";
      if (parameter === 37446 && (!result || String(result).includes("SwiftShader"))) {
        return "Intel Iris OpenGL Engine";
      }
      return result;
    };
    Object.defineProperty(replacement, "__agentBrowserStealthPatched", { value: true });
    proto.getParameter = replacement;
  };
  patchPrototype(globalThis.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchPrototype(globalThis.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
});