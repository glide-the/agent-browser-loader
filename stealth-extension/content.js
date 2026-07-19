(function applyStealthProfile() {
  const registryName = "__agentBrowserStealthProfilePatches";
  const registry = globalThis[registryName];

  try {
    if (Array.isArray(registry)) {
      for (const patch of registry) {
        try {
          patch();
        } catch (_) {}
      }
    }
  } finally {
    try {
      delete globalThis[registryName];
    } catch (_) {}
  }
})();