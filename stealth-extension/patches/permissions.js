(function registerPatch(patch) {
  const name = "__agentBrowserStealthProfilePatches";
  let registry = globalThis[name];
  if (!Array.isArray(registry)) {
    registry = [];
    Object.defineProperty(globalThis, name, { value: registry, configurable: true });
  }
  registry.push(patch);
})(function patchPermissions() {
  if (!globalThis.Notification || !globalThis.Permissions || !Permissions.prototype.query) return;
  const original = Permissions.prototype.query;
  if (original.__agentBrowserStealthPatched) return;
  const replacement = function query(parameters) {
    if (parameters && parameters.name === "notifications") {
      const state = location.protocol === "https:" ? Notification.permission : "denied";
      const status = { state, onchange: null };
      if (globalThis.PermissionStatus) Object.setPrototypeOf(status, PermissionStatus.prototype);
      return Promise.resolve(status);
    }
    return original.apply(this, arguments);
  };
  Object.defineProperty(replacement, "__agentBrowserStealthPatched", { value: true });
  Permissions.prototype.query = replacement;
});