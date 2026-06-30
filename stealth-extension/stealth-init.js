// agent-browser-stealth-init
// Stealth init script injected at document_start in the MAIN world.
// Mirrors INIT_SCRIPTS from plugins/agent-browser-plugin-stealth/src/index.ts
// so start-chrome-debug.sh gains the same initScripts capability when Chrome
// is launched manually in remote-debugging mode.
(function() {
  try {
    var navProto = Object.getPrototypeOf(navigator);
    var defineGetter = function(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, { get: getter, configurable: true });
      } catch (e) {}
    };
    var defineValue = function(target, prop, value) {
      try {
        Object.defineProperty(target, prop, {
          value: value,
          writable: true,
          enumerable: true,
          configurable: true
        });
      } catch (e) {
        try { target[prop] = value; } catch (_) {}
      }
    };
    var nativeFunctionToString = Function.prototype.toString;
    var nativeSourceMap = typeof WeakMap === 'function' ? new WeakMap() : null;
    var registerNativeSource = function(fn, source) {
      try {
        if (nativeSourceMap && typeof fn === 'function') {
          nativeSourceMap.set(fn, source);
        }
      } catch (e) {}
    };
    try {
      var patchedToString = function toString() {
        if (nativeSourceMap && nativeSourceMap.has(this)) {
          return nativeSourceMap.get(this);
        }
        return nativeFunctionToString.call(this);
      };
      Object.defineProperty(patchedToString, '__agentBrowserStealthPatched', { value: true });
      registerNativeSource(patchedToString, nativeFunctionToString.call(nativeFunctionToString));
      Object.defineProperty(Function.prototype, 'toString', {
        value: patchedToString,
        writable: true,
        configurable: true
      });
    } catch (e) {}
    var asNative = function(fn, name) {
      var source = 'function ' + name + '() { [native code] }';
      registerNativeSource(fn, source);
      try {
        Object.defineProperty(fn, 'toString', {
          value: function() { return source; },
          configurable: true
        });
      } catch (e) {}
      return fn;
    };
    var replaceMethod = function(target, prop, fn) {
      try {
        var descriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (descriptor && descriptor.configurable !== false) {
          Object.defineProperty(target, prop, {
            value: fn,
            writable: descriptor.writable !== false,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable
          });
        } else {
          target[prop] = fn;
        }
      } catch (e) {
        try { target[prop] = fn; } catch (_) {}
      }
    };

    // console.table/performance.now timing probes used by devtools detectors.
    // performance.now must be strictly increasing; some detectors treat t1 === t2
    // as proof that now() was hooked and then trigger destructive branches.
    try {
      if (window.console && typeof console.table === 'function' && !console.table.__agentBrowserStealthAntiDebugPatched) {
        var table = function table() {};
        Object.defineProperty(table, '__agentBrowserStealthAntiDebugPatched', { value: true });
        replaceMethod(console, 'table', asNative(table, 'table'));
      }
    } catch (e) {}
    try {
      if (window.performance && typeof performance.now === 'function' && !performance.now.__agentBrowserStealthAntiDebugPatched) {
        var navStart = typeof performance.timeOrigin === 'number'
          ? performance.timeOrigin
          : (performance.timing && performance.timing.navigationStart) || Date.now();
        var lastMonotonicPerformanceNow = 0;
        var minimumMonotonicStepMs = 0.001;
        var now = function now() {
          var elapsed = Date.now() - navStart;
          if (!isFinite(elapsed)) {
            elapsed = 0;
          }
          if (elapsed <= lastMonotonicPerformanceNow) {
            elapsed = lastMonotonicPerformanceNow + minimumMonotonicStepMs;
          }
          lastMonotonicPerformanceNow = elapsed;
          return elapsed;
        };
        Object.defineProperty(now, '__agentBrowserStealthAntiDebugPatched', { value: true });
        replaceMethod(performance, 'now', asNative(now, 'now'));
      }
    } catch (e) {}

    // navigator.webdriver
    try {
      if (navigator.webdriver !== false && navigator.webdriver !== undefined) {
        delete navProto.webdriver;
      }
      defineGetter(navProto, 'webdriver', function() { return undefined; });
    } catch (e) {}

    // User agent cleanup when a headless UA leaks before agent-browser overrides it.
    try {
      if (navigator.userAgent && navigator.userAgent.indexOf('HeadlessChrome/') !== -1) {
        var cleanUA = navigator.userAgent.replace('HeadlessChrome/', 'Chrome/');
        defineGetter(navProto, 'userAgent', function() { return cleanUA; });
        if (navigator.appVersion) {
          defineGetter(navProto, 'appVersion', function() {
            return navigator.appVersion.replace('HeadlessChrome/', 'Chrome/');
          });
        }
      }
    } catch (e) {}

    // navigator fallbacks: only patch suspicious empty values.
    try {
      if (!navigator.languages || navigator.languages.length === 0) {
        defineGetter(navProto, 'languages', function() { return Object.freeze(['en-US', 'en']); });
      }
    } catch (e) {}
    try {
      if (!navigator.vendor) {
        defineGetter(navProto, 'vendor', function() { return 'Google Inc.'; });
      }
    } catch (e) {}
    try {
      if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency < 2) {
        defineGetter(navProto, 'hardwareConcurrency', function() { return 4; });
      }
    } catch (e) {}

    // window.chrome app/runtime/csi/loadTimes shape.
    try {
      if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
          value: {},
          writable: true,
          enumerable: true,
          configurable: false
        });
      }

      if (!('app' in window.chrome)) {
        defineValue(window.chrome, 'app', {
          isInstalled: false,
          InstallState: {
            DISABLED: 'disabled',
            INSTALLED: 'installed',
            NOT_INSTALLED: 'not_installed'
          },
          RunningState: {
            CANNOT_RUN: 'cannot_run',
            READY_TO_RUN: 'ready_to_run',
            RUNNING: 'running'
          },
          getDetails: asNative(function getDetails() { return null; }, 'getDetails'),
          getIsInstalled: asNative(function getIsInstalled() { return false; }, 'getIsInstalled'),
          runningState: asNative(function runningState() { return 'cannot_run'; }, 'runningState')
        });
      }

      if (!('runtime' in window.chrome)) {
        defineValue(window.chrome, 'runtime', {
          OnInstalledReason: {
            CHROME_UPDATE: 'chrome_update',
            INSTALL: 'install',
            SHARED_MODULE_UPDATE: 'shared_module_update',
            UPDATE: 'update'
          },
          OnRestartRequiredReason: {
            APP_UPDATE: 'app_update',
            OS_UPDATE: 'os_update',
            PERIODIC: 'periodic'
          },
          PlatformArch: {
            ARM: 'arm',
            ARM64: 'arm64',
            MIPS: 'mips',
            MIPS64: 'mips64',
            X86_32: 'x86-32',
            X86_64: 'x86-64'
          },
          PlatformNaclArch: {
            ARM: 'arm',
            MIPS: 'mips',
            MIPS64: 'mips64',
            X86_32: 'x86-32',
            X86_64: 'x86-64'
          },
          PlatformOs: {
            ANDROID: 'android',
            CROS: 'cros',
            LINUX: 'linux',
            MAC: 'mac',
            OPENBSD: 'openbsd',
            WIN: 'win'
          },
          RequestUpdateCheckStatus: {
            NO_UPDATE: 'no_update',
            THROTTLED: 'throttled',
            UPDATE_AVAILABLE: 'update_available'
          },
          get id() { return undefined; },
          connect: asNative(function connect() { return undefined; }, 'connect'),
          sendMessage: asNative(function sendMessage() { return undefined; }, 'sendMessage')
        });
      }

      if (!('csi' in window.chrome) && window.performance && window.performance.timing) {
        window.chrome.csi = asNative(function csi() {
          var timing = window.performance.timing;
          return {
            onloadT: timing.domContentLoadedEventEnd,
            startE: timing.navigationStart,
            pageT: Date.now() - timing.navigationStart,
            tran: 15
          };
        }, 'csi');
      }

      if (!('loadTimes' in window.chrome) && window.performance && window.performance.timing) {
        window.chrome.loadTimes = asNative(function loadTimes() {
          var performance = window.performance;
          var timing = performance.timing;
          var navEntry = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
          var protocol = (navEntry && navEntry.nextHopProtocol) || 'h2';
          return {
            requestTime: timing.navigationStart / 1000,
            startLoadTime: timing.navigationStart / 1000,
            commitLoadTime: timing.responseStart / 1000,
            finishDocumentLoadTime: timing.domContentLoadedEventEnd / 1000,
            finishLoadTime: timing.loadEventEnd / 1000,
            firstPaintTime: timing.loadEventEnd / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: (navEntry && navEntry.type) || 'other',
            connectionInfo: protocol,
            npnNegotiatedProtocol: protocol,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: protocol === 'h2' || protocol === 'hq',
            wasNpnNegotiated: protocol === 'h2' || protocol === 'hq'
          };
        }, 'loadTimes');
      }
    } catch (e) {}

    // navigator.plugins and navigator.mimeTypes fallback for empty headless arrays.
    try {
      if (navigator.plugins && navigator.plugins.length === 0) {
        var pluginData = [
          {
            name: 'Chrome PDF Plugin',
            filename: 'internal-pdf-viewer',
            description: 'Portable Document Format',
            mimeTypes: ['application/x-google-chrome-pdf']
          },
          {
            name: 'Chrome PDF Viewer',
            filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
            description: '',
            mimeTypes: ['application/pdf']
          },
          {
            name: 'Native Client',
            filename: 'internal-nacl-plugin',
            description: '',
            mimeTypes: ['application/x-nacl', 'application/x-pnacl']
          }
        ];
        var mimeData = {
          'application/pdf': { suffixes: 'pdf', description: '', pluginName: 'Chrome PDF Viewer' },
          'application/x-google-chrome-pdf': { suffixes: 'pdf', description: 'Portable Document Format', pluginName: 'Chrome PDF Plugin' },
          'application/x-nacl': { suffixes: '', description: 'Native Client Executable', pluginName: 'Native Client' },
          'application/x-pnacl': { suffixes: '', description: 'Portable Native Client Executable', pluginName: 'Native Client' }
        };
        var makeArray = function(items, nameProp) {
          var arr = [];
          items.forEach(function(item, index) {
            arr[index] = item;
            Object.defineProperty(arr, item[nameProp], { value: item, enumerable: false, configurable: true });
          });
          Object.defineProperty(arr, 'length', { value: items.length, enumerable: false, configurable: true });
          defineValue(arr, 'item', asNative(function item(index) { return arr[index] || null; }, 'item'));
          defineValue(arr, 'namedItem', asNative(function namedItem(name) { return arr[name] || null; }, 'namedItem'));
          return arr;
        };
        var plugins = makeArray(pluginData.map(function(plugin) {
          var pluginObj = {
            name: plugin.name,
            filename: plugin.filename,
            description: plugin.description,
            length: plugin.mimeTypes.length,
            item: asNative(function item(index) { return pluginObj[index] || null; }, 'item'),
            namedItem: asNative(function namedItem(name) { return pluginObj[name] || null; }, 'namedItem')
          };
          plugin.mimeTypes.forEach(function(type, index) {
            pluginObj[index] = type;
            Object.defineProperty(pluginObj, type, { value: type, enumerable: false, configurable: true });
          });
          return pluginObj;
        }), 'name');
        defineValue(plugins, 'refresh', asNative(function refresh() {}, 'refresh'));
        var mimeTypes = makeArray(Object.keys(mimeData).map(function(type) {
          return {
            type: type,
            suffixes: mimeData[type].suffixes,
            description: mimeData[type].description,
            enabledPlugin: plugins[mimeData[type].pluginName]
          };
        }), 'type');
        if (window.PluginArray) {
          Object.setPrototypeOf(plugins, PluginArray.prototype);
        }
        if (window.MimeTypeArray) {
          Object.setPrototypeOf(mimeTypes, MimeTypeArray.prototype);
        }
        defineGetter(navProto, 'plugins', function() { return plugins; });
        defineGetter(navProto, 'mimeTypes', function() { return mimeTypes; });
      }
    } catch (e) {}

    // HTMLMediaElement codecs.
    try {
      var originalCanPlayType = HTMLMediaElement.prototype.canPlayType;
      if (originalCanPlayType && !originalCanPlayType.__agentBrowserStealthPatched) {
        var canPlayType = function canPlayType(type) {
          if (typeof type === 'string') {
            var normalized = type.trim().toLowerCase();
            if (normalized.indexOf('video/mp4') === 0 && normalized.indexOf('avc1.42e01e') !== -1) {
              return 'probably';
            }
            if (normalized === 'audio/x-m4a;' || normalized === 'audio/x-m4a') {
              return 'maybe';
            }
            if (normalized === 'audio/aac;' || normalized === 'audio/aac') {
              return 'probably';
            }
          }
          return originalCanPlayType.apply(this, arguments);
        };
        Object.defineProperty(canPlayType, '__agentBrowserStealthPatched', { value: true });
        HTMLMediaElement.prototype.canPlayType = asNative(canPlayType, 'canPlayType');
      }
    } catch (e) {}

    // Permissions API notification behavior.
    try {
      if (window.Notification && window.Permissions && Permissions.prototype.query) {
        var originalQuery = Permissions.prototype.query;
        if (!originalQuery.__agentBrowserStealthPatched) {
          var query = function query(param) {
            if (param && param.name === 'notifications') {
              var state = location.protocol.indexOf('https') === 0 ? Notification.permission : 'denied';
              if (window.PermissionStatus) {
                return Promise.resolve(Object.setPrototypeOf({ state: state, onchange: null }, PermissionStatus.prototype));
              }
              return Promise.resolve({ state: state, onchange: null });
            }
            return originalQuery.apply(this, arguments);
          };
          Object.defineProperty(query, '__agentBrowserStealthPatched', { value: true });
          Permissions.prototype.query = asNative(query, 'query');
        }
      }
    } catch (e) {}

    // WebGL vendor/renderer: only mask obvious headless software values.
    try {
      var patchWebGL = function(proto) {
        if (!proto || !proto.getParameter || proto.getParameter.__agentBrowserStealthPatched) {
          return;
        }
        var originalGetParameter = proto.getParameter;
        var getParameter = function getParameter(param) {
          var result = originalGetParameter.apply(this, arguments);
          if (param === 37445 && (!result || String(result).indexOf('Google') !== -1)) {
            return 'Intel Inc.';
          }
          if (param === 37446 && (!result || String(result).indexOf('SwiftShader') !== -1)) {
            return 'Intel Iris OpenGL Engine';
          }
          return result;
        };
        Object.defineProperty(getParameter, '__agentBrowserStealthPatched', { value: true });
        proto.getParameter = asNative(getParameter, 'getParameter');
      };
      patchWebGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
      patchWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    } catch (e) {}

    // Headless outer dimensions.
    try {
      if (!window.outerWidth || !window.outerHeight) {
        Object.defineProperty(window, 'outerWidth', { get: function() { return window.innerWidth; }, configurable: true });
        Object.defineProperty(window, 'outerHeight', { get: function() { return window.innerHeight + 85; }, configurable: true });
      }
    } catch (e) {}

    // srcdoc iframe contentWindow shape.
    try {
      var originalCreateElement = Document.prototype.createElement;
      if (originalCreateElement && !originalCreateElement.__agentBrowserStealthPatched) {
        var createElement = function createElement(tagName) {
          var element = originalCreateElement.apply(this, arguments);
          if (String(tagName).toLowerCase() === 'iframe') {
            try {
              var originalSrcdoc = element.srcdoc;
              Object.defineProperty(element, 'srcdoc', {
                configurable: true,
                get: function() { return originalSrcdoc; },
                set: function(value) {
                  if (!element.contentWindow) {
                    var proxy = new Proxy(window, {
                      get: function(target, key) {
                        if (key === 'self') return proxy;
                        if (key === 'frameElement') return element;
                        if (key === '0') return undefined;
                        return Reflect.get(target, key);
                      }
                    });
                    Object.defineProperty(element, 'contentWindow', {
                      get: function() { return proxy; },
                      configurable: false
                    });
                  }
                  Object.defineProperty(element, 'srcdoc', { value: value, writable: true, configurable: true });
                }
              });
            } catch (e) {}
          }
          return element;
        };
        Object.defineProperty(createElement, '__agentBrowserStealthPatched', { value: true });
        Document.prototype.createElement = asNative(createElement, 'createElement');
      }
    } catch (e) {}
  } catch(e) {}
})();
