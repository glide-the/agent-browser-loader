(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchPlugins() {
  if (!navigator.plugins || navigator.plugins.length !== 0) return;
  const proto = Object.getPrototypeOf(navigator);
  const pluginDefinitions = [
    ["Chrome PDF Plugin", "internal-pdf-viewer", "Portable Document Format"],
    ["Chrome PDF Viewer", "mhjfbmdgcfjbbpaeojofohoefgiehjai", ""],
    ["Native Client", "internal-nacl-plugin", ""]
  ];
  const plugins = pluginDefinitions.map(([name, filename, description]) => ({
    name,
    filename,
    description,
    length: 0
  }));
  for (const [index, plugin] of plugins.entries()) {
    Object.defineProperty(plugins, plugin.name, { value: plugin, configurable: true });
    Object.defineProperty(plugins, index, { value: plugin, enumerable: true, configurable: true });
  }
  Object.defineProperties(plugins, {
    item: { value: function item(index) { return plugins[index] || null; }, configurable: true },
    namedItem: { value: function namedItem(name) { return plugins[name] || null; }, configurable: true },
    refresh: { value: function refresh() {}, configurable: true }
  });
  if (globalThis.PluginArray) Object.setPrototypeOf(plugins, PluginArray.prototype);
  Object.defineProperty(proto, "plugins", {
    get: function getPlugins() { return plugins; },
    configurable: true
  });
});