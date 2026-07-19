const PROFILE_DEFINITIONS = [
  {
    name: "boss",
    matches: ["*://zhipin.com/*", "*://*.zhipin.com/*"]
  },
  {
    name: "google",
    matches: ["*://google.com/*", "*://*.google.com/*"]
  },
  {
    name: "default",
    matches: ["<all_urls>"],
    excludeMatches: [
      "*://zhipin.com/*",
      "*://*.zhipin.com/*",
      "*://google.com/*",
      "*://*.google.com/*"
    ]
  }
];

const PATCH_FILES = {
  webdriver: "patches/webdriver.js",
  consoleTable: "patches/console-table.js",
  performanceNow: "patches/performance-now.js",
  chromeRuntime: "patches/chrome-runtime.js",
  headlessUA: "patches/headless-ua.js",
  plugins: "patches/plugins.js",
  webgl: "patches/webgl.js",
  iframe: "patches/iframe.js",
  permissions: "patches/permissions.js",
  functionToString: "patches/function-tostring.js"
};

async function loadProfile(name) {
  const response = await fetch(chrome.runtime.getURL(`profiles/${name}.json`));
  if (!response.ok) {
    throw new Error(`Unable to load stealth profile: ${name}`);
  }
  return response.json();
}

async function configureProfiles() {
  const previous = await chrome.scripting.getRegisteredContentScripts({
    ids: PROFILE_DEFINITIONS.map(({ name }) => `stealth-profile-${name}`)
  });
  if (previous.length > 0) {
    await chrome.scripting.unregisterContentScripts({
      ids: previous.map(({ id }) => id)
    });
  }

  const registrations = [];
  for (const definition of PROFILE_DEFINITIONS) {
    const profile = await loadProfile(definition.name);
    const patchFiles = Object.entries(profile.patches)
      .filter(([, enabled]) => enabled)
      .map(([patchName]) => PATCH_FILES[patchName]);

    if (patchFiles.some((file) => !file)) {
      throw new Error(`Unknown patch configured by profile: ${profile.name}`);
    }

    registrations.push({
      id: `stealth-profile-${definition.name}`,
      matches: definition.matches,
      excludeMatches: definition.excludeMatches,
      js: [...patchFiles, "content.js"],
      runAt: "document_start",
      allFrames: true,
      matchOriginAsFallback: true,
      world: "MAIN",
      persistAcrossSessions: true
    });
  }

  await chrome.scripting.registerContentScripts(registrations);
}

let configureQueue = Promise.resolve();

function scheduleConfigureProfiles() {
  configureQueue = configureQueue.then(configureProfiles, configureProfiles);
  return configureQueue;
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleConfigureProfiles().catch((error) => console.error(error));
});

chrome.runtime.onStartup.addListener(() => {
  scheduleConfigureProfiles().catch((error) => console.error(error));
});

scheduleConfigureProfiles().catch((error) => console.error(error));