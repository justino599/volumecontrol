const browserApi = (typeof browser !== 'undefined') ? browser : chrome;
const cached = {
  slider: null,
  volumeText: null,
  monoCheckbox: null,
  rememberCheckbox: null,
  rememberPathCheckbox: null,
  enableCheckbox: null
};

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      browserApi.storage.local.get(keys, (res) => {
        if (browserApi.runtime.lastError) reject(browserApi.runtime.lastError);
        else resolve(res);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      browserApi.storage.local.set(obj, () => {
        if (browserApi.runtime.lastError) reject(browserApi.runtime.lastError);
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
} 

function extractRootDomain(url) {
    if (!url) return null;
    if (url.startsWith('file:')) return 'Local File';
    if (url.startsWith('chrome') || url.startsWith('edge') || url.startsWith('about') || url.startsWith('extension')) return null;

    let domain = url.replace(/^(https?|ftp):\/\/(www\.)?/, '');
    domain = domain.split('/')[0];
    domain = domain.split(':')[0];
    return domain.toLowerCase();
}

function extractSitePath(url) {
    if (!url) return null;
    if (url.startsWith('file:')) return 'Local File';
    if (url.startsWith('chrome') || url.startsWith('edge') || url.startsWith('about') || url.startsWith('extension')) return null;

    try {
        const parsed = new URL(url);
        let hostname = parsed.hostname.toLowerCase();
        if (hostname.startsWith('www.')) hostname = hostname.slice(4);
        const pathname = parsed.pathname;
        if (!pathname || pathname === '/') return hostname;
        if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
        return hostname + pathname.toLowerCase();
    } catch (e) {
        return extractRootDomain(url);
    }
}

function getRememberKey(tab, usePath) {
    return usePath ? extractSitePath(tab.url) : extractRootDomain(tab.url);
}

function findRememberedSetting(siteSettings, tab) {
    if (!siteSettings || !tab || !tab.url) return null;
    const pathKey = extractSitePath(tab.url);
    const domainKey = extractRootDomain(tab.url);
    if (pathKey && siteSettings[pathKey]) return { key: pathKey, settings: siteSettings[pathKey] };
    if (domainKey && siteSettings[domainKey]) return { key: domainKey, settings: siteSettings[domainKey] };
    return null;
}

document.addEventListener('DOMContentLoaded', () => {
  const slider = document.getElementById('volume-slider');
  if (slider) {
      slider.focus();
  }

  const settingsBtn = document.getElementById('settings');
  if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
          if (browserApi.runtime.openOptionsPage) {
              browserApi.runtime.openOptionsPage(() => {
                  if (browserApi.runtime.lastError) console.error(browserApi.runtime.lastError);
              });
          } else {
              window.open(browserApi.runtime.getURL('options.html'));
          }
      });
  }

  browserApi.runtime.onMessage.addListener((message) => {
    if (message.type === "exclusion") showError({ type: "exclusion" });
  });

  listenForEvents();
});

function listenForEvents() {
  browserApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      handleTabs(tabs);
  });
}

function handleTabs(tabs) {
    const currentTab = tabs && tabs[0];
    
    if (!currentTab || !currentTab.url) {
        showError({ message: "No active tab." });
        return;
    }

    const protocol = currentTab.url.split(':')[0];
    const restrictedProtocols = ['chrome', 'edge', 'about', 'extension', 'chrome-extension', 'moz-extension', 'view-source'];
    
    if (restrictedProtocols.includes(protocol)) {
        showError({ message: "Volume control is not available on system pages." });
        const switchLabel = document.querySelector('label[for="enable-checkbox"]');
        if(switchLabel) switchLabel.style.display = 'none';
        return;
    }

    updateEnableSwitch(currentTab);

    browserApi.tabs.sendMessage(currentTab.id, { command: "checkExclusion" }, (response) => {
        if (browserApi.runtime.lastError) {
            // Content script didn't respond — fall back to storage check to decide whether the page is truly excluded.
            (async () => {
                try {
                    const domain = extractRootDomain(currentTab.url);
                    if (!domain) {
                        showError({ type: "exclusion" });
                        return;
                    }
                    const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {} });
                    let isExcluded = false;
                    if (data.whitelistMode) {
                        isExcluded = !findRememberedSetting(data.siteSettings, currentTab);
                    } else {
                        isExcluded = data.fqdns.includes(domain);
                    }
                    if (isExcluded) showError({ type: "exclusion" });
                } catch (e) {
                    showError({ type: "exclusion" });
                }
            })();
        }
    });
    
    initializeControls(currentTab);
}

async function updateEnableSwitch(tab) {
    const checkbox = document.getElementById('enable-checkbox');
    const switchLabel = document.querySelector('label[for="enable-checkbox"]');
    const domain = extractRootDomain(tab.url);
    
    if (!domain) {
        if (switchLabel) switchLabel.style.display = 'none';
        return;
    } else {
        if (switchLabel) switchLabel.style.display = 'flex';
    }

    try {
        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {} });

        // When whitelist mode is active, remembered sites determine which pages are allowed.
        // Hide the enable/active switch to avoid duplicate controls and potential user confusion.
        if (data.whitelistMode) {
            if (switchLabel) switchLabel.style.display = 'none';
            return;
        }

        let isExcluded = data.fqdns.includes(domain);

        if (checkbox) checkbox.checked = !isExcluded;

        checkbox.onchange = (e) => {
            const isActive = e.target.checked;
            toggleSitePermission(domain, !isActive, tab.id);
        };
    } catch (e) {
        handleError(e);
    }
} 

async function toggleSitePermission(domain, shouldExclude, tabId) {
    try {
        const data = await storageGet({ fqdns: [], whitelist: [], whitelistMode: false });
        const newData = {};

        if (data.whitelistMode) {
            // Edit remembered sites instead of an arbitrary whitelist
            const sd = await storageGet({ siteSettings: {} });
            const settings = sd.siteSettings || {};
            if (shouldExclude) {
                const found = findRememberedSetting(settings, tab);
                if (found) {
                    delete settings[found.key];
                    await storageSet({ siteSettings: settings });
                }
            } else {
                if (!findRememberedSetting(settings, tab)) {
                    settings[domain] = { volume: 0, mono: false };
                    await storageSet({ siteSettings: settings });
                    // Try to apply settings immediately to the tab that requested the change
                    if (tabId) {
                        try {
                            browserApi.tabs.sendMessage(tabId, { command: "setVolume", dB: settings[domain].volume }, () => {});
                            browserApi.tabs.sendMessage(tabId, { command: "setMono", mono: Boolean(settings[domain].mono) }, () => {});
                        } catch (e) { /* ignore */ }
                    }
                }
            }
        } else {
            newData.fqdns = data.fqdns || [];
            if (shouldExclude) {
                if (!newData.fqdns.includes(domain)) newData.fqdns.push(domain);
            } else {
                const idx = newData.fqdns.indexOf(domain);
                if (idx > -1) newData.fqdns.splice(idx, 1);
            }
            await storageSet({ fqdns: newData.fqdns });
        }

        browserApi.tabs.reload(tabId);
        window.close();
    } catch (e) {
        handleError(e);
    }
} 

function handleError(error) {
  const msg = error.message || error;
  if (typeof msg === 'string') {
      if (msg.includes("Receiving end does not exist") ||
          msg.includes("Could not establish connection") ||
          msg.includes("message channel closed")
      ) {
          return;
      }
  }
  console.error(`Volume Control: Error: ${msg}`);
}

function formatValue(dB) {
  const n = Number(dB);
  if (Number.isNaN(n)) return '';
  return `${n >= 0 ? '+' : ''}${n} dB`;
}

async function saveSiteSettings(tab) {
    try {
        const rememberCheckbox = cached.rememberCheckbox || document.getElementById("remember-checkbox");
        const rememberPathCheckbox = cached.rememberPathCheckbox || document.getElementById("remember-path-checkbox");
        if (!rememberCheckbox || !rememberCheckbox.checked || !tab || !tab.url) return;

        const usePath = rememberPathCheckbox && rememberPathCheckbox.checked;
        const key = getRememberKey(tab, usePath);
        if (!key) return;

        const pathKey = extractSitePath(tab.url);
        const domainKey = extractRootDomain(tab.url);

        const volumeSlider = cached.slider || document.getElementById("volume-slider");
        const monoCheckbox = cached.monoCheckbox || document.getElementById("mono-checkbox");

        const data = await storageGet({ siteSettings: {} });
        data.siteSettings = data.siteSettings || {};

        if (usePath) {
            if (domainKey && data.siteSettings[domainKey]) delete data.siteSettings[domainKey];
        } else {
            if (pathKey && data.siteSettings[pathKey]) delete data.siteSettings[pathKey];
        }

        data.siteSettings[key] = {
            volume: parseInt(volumeSlider?.value, 10) || 0,
            mono: Boolean(monoCheckbox?.checked)
        };
        await storageSet({ siteSettings: data.siteSettings });

        // Notify the content script in this tab immediately so volume/mono are applied without waiting
        if (tab && tab.id) {
            try {
                browserApi.tabs.sendMessage(tab.id, { command: "setVolume", dB: data.siteSettings[key].volume }, () => {
                    if (browserApi.runtime && browserApi.runtime.lastError) {
                        // It's possible the content script hasn't injected into the page yet; ignore harmless errors.
                    }
                });
                browserApi.tabs.sendMessage(tab.id, { command: "setMono", mono: Boolean(data.siteSettings[key].mono) }, () => {
                    if (browserApi.runtime && browserApi.runtime.lastError) {}
                });
            } catch (e) {
                // ignore messaging errors
            }
        }
    } catch (e) {
        handleError(e);
    }
} 

async function setVolume(dB, tab) {
  const slider = cached.slider || document.querySelector("#volume-slider");
  const text = cached.volumeText || document.querySelector("#volume-text");
  if (slider) slider.value = String(dB);
  if (text) text.value = formatValue(dB);

  if (tab) {
      browserApi.tabs.sendMessage(tab.id, { command: "setVolume", dB: Number(dB) }, (response) => {
          if (browserApi.runtime.lastError) handleError(browserApi.runtime.lastError);
      });
      await saveSiteSettings(tab);
  }
}

async function toggleMono(tab) {
  const monoCheckbox = cached.monoCheckbox || document.querySelector("#mono-checkbox");
  if (tab && monoCheckbox) {
      browserApi.tabs.sendMessage(tab.id, { command: "setMono", mono: monoCheckbox.checked }, (res) => {
           if (browserApi.runtime.lastError) handleError(browserApi.runtime.lastError);
      });
      await saveSiteSettings(tab);
  }
}

async function toggleRemember(tab) {
    try {
        const rememberCheckbox = cached.rememberCheckbox || document.getElementById("remember-checkbox");
        const rememberPathCheckbox = cached.rememberPathCheckbox || document.getElementById("remember-path-checkbox");
        const usePath = rememberPathCheckbox && rememberPathCheckbox.checked;
        const key = getRememberKey(tab, usePath);
        if (!key) return;

        if (rememberCheckbox && rememberCheckbox.checked) {
            await saveSiteSettings(tab);
        } else {
            const data = await storageGet({ siteSettings: {} });
            if (data.siteSettings && data.siteSettings[key]) {
                delete data.siteSettings[key];
                await storageSet({ siteSettings: data.siteSettings });
            }
        }
    } catch (e) {
        handleError(e);
    }
}

function showError(error) {
  const popupContent = document.querySelector("#popup-content");
  const errorContent = document.querySelector("#error-content");
  const exclusionMessage = document.querySelector(".exclusion-message");
  
  if (popupContent) popupContent.classList.add("hidden");
  if (errorContent) errorContent.classList.add("hidden");
  if (exclusionMessage) exclusionMessage.classList.add("hidden");

  if (error.type === "exclusion") {
    if (popupContent) popupContent.classList.remove("hidden");
    if (exclusionMessage) exclusionMessage.classList.remove("hidden");
    
    const top = document.querySelector(".top-controls");
    const left = document.querySelector(".left");
    if(top) top.classList.add("hidden");
    if(left) left.classList.add("hidden"); 
    document.body.classList.add("excluded-site");
  } else {
    if (errorContent) {
        errorContent.classList.remove("hidden");
        errorContent.querySelector("p").textContent = error.message || "An error occurred";
    }
  }
}

async function initializeControls(tab) {
    if (!tab) return;

    const volumeSlider = document.querySelector("#volume-slider");
    const volumeText = document.querySelector("#volume-text");
    const monoCheckbox = document.querySelector("#mono-checkbox");
    const rememberCheckbox = document.querySelector("#remember-checkbox");
    const rememberPathCheckbox = document.querySelector("#remember-path-checkbox");

    cached.slider = volumeSlider;
    cached.volumeText = volumeText;
    cached.monoCheckbox = monoCheckbox;
    cached.rememberCheckbox = rememberCheckbox;
    cached.rememberPathCheckbox = rememberPathCheckbox;

    if (volumeSlider) {
      volumeSlider.addEventListener("input", () => {
          if (cached.volumeText) cached.volumeText.value = formatValue(volumeSlider.value);
          setVolume(volumeSlider.value, tab);
      });
    }
    
    if (volumeText) {
      volumeText.addEventListener("change", () => {
           const val = volumeText.value.match(/-?\d+/)?.[0];
           if (val) setVolume(val, tab);
      });
    }

    if (monoCheckbox) monoCheckbox.addEventListener("change", () => toggleMono(tab));
    if (rememberCheckbox) rememberCheckbox.addEventListener("change", () => toggleRemember(tab));
    if (rememberPathCheckbox) rememberPathCheckbox.addEventListener("change", () => {
        if (cached.rememberCheckbox && cached.rememberCheckbox.checked) saveSiteSettings(tab);
    });

    const domain = extractRootDomain(tab.url);
    if (!domain) return;

    try {
        const data = await storageGet({ siteSettings: {} });
        const found = findRememberedSetting(data.siteSettings, tab);
        if (found) {
            if (rememberCheckbox) rememberCheckbox.checked = true;
            const pathKey = extractSitePath(tab.url);
            if (rememberPathCheckbox) rememberPathCheckbox.checked = found.key === pathKey;
            if (found.settings.volume !== undefined) setVolume(found.settings.volume, null);
            if (found.settings.mono !== undefined && monoCheckbox) monoCheckbox.checked = found.settings.mono;
        } else {
            browserApi.tabs.sendMessage(tab.id, { command: "getVolume" }, (response) => {
                if (!browserApi.runtime.lastError && response && response.response !== undefined) {
                    setVolume(response.response, null);
                }
            });
            browserApi.tabs.sendMessage(tab.id, { command: "getMono" }, (response) => {
                if (!browserApi.runtime.lastError && response && response.response !== undefined) {
                    if (monoCheckbox) monoCheckbox.checked = response.response;
                }
            });
        }
    } catch (e) {
        handleError(e);
    }
}