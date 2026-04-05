const browserAPI = (typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null));

const tc = {
  settings: {
    logLevel: 4,
    debugMode: false
  },
  vars: {
    dB: 0,
    mono: false,
    audioCtx: undefined,
    gainNode: undefined,
    isBlocked: false
  }
};

const logTypes = ["ERROR", "WARNING", "INFO", "DEBUG"];
function log(msg, level = 4) {
  if (tc.settings.logLevel >= level) console.log(`[VolumeControl] ${logTypes[level-2]}: ${msg}`);
}

if (browserAPI) {
    browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (tc.vars.isBlocked) return;
        switch (msg.command) {
            case "checkExclusion":
                sendResponse({ status: "active" });
                break;
            case "setVolume":
                tc.vars.dB = msg.dB;
                applyState();
                sendResponse({});
                break;
            case "getVolume":
                sendResponse({ response: tc.vars.dB });
                break;
            case "setMono":
                tc.vars.mono = msg.mono;
                applyState();
                sendResponse({});
                break;
            case "getMono":
                sendResponse({ response: tc.vars.mono });
                break;
        }
        return true;
    });
}

function getGainValue(dB) {
    const n = Number(dB);
    if (Number.isNaN(n)) return 1.0;
    return Math.pow(10, n / 20);
}

function applyState() {
    const audioCtx = tc.vars.audioCtx;
    const gainNode = tc.vars.gainNode;
    const targetGain = getGainValue(tc.vars.dB);

    if (gainNode && audioCtx) {
        const now = audioCtx.currentTime;
        gainNode.gain.value = targetGain;

        if (audioCtx.state === 'running') {
            try {
                gainNode.gain.cancelScheduledValues(now);
                gainNode.gain.setValueAtTime(targetGain, now);
            } catch (e) {
                if (tc.settings.debugMode) log(`applyState schedule failed: ${e.message}`, 2);
            }
        }

        if (tc.vars.mono) {
            gainNode.channelCountMode = "explicit";
            gainNode.channelCount = 1;
        } else {
            gainNode.channelCountMode = "max";
            gainNode.channelCount = 2;
        }
    }

    // Also update any fallback elements where we couldn't hook into WebAudio
    try {
        for (const el of document.querySelectorAll('audio, video')) {
            if (el.dataset.vcFallback === 'true') {
                try {
                    const gain = targetGain;
                    const newVol = Math.min(1, Math.max(0, gain));
                    el.volume = newVol;
                } catch (e) {
                    if (tc.settings.debugMode) log(`applyState fallback update failed: ${e.message}`, 3);
                }
            }
        }
    } catch (e) {
        if (tc.settings.debugMode) log(`applyState fallback loop failed: ${e.message}`, 3);
    }
}

function createGainNode() {
    if (!tc.vars.audioCtx) return;

    if (!tc.vars.gainNode) {
        tc.vars.gainNode = tc.vars.audioCtx.createGain();
        tc.vars.gainNode.channelInterpretation = "speakers";
    }
    applyState();
}

function connectOutput(element) {
    if (element.dataset.vcHooked === "true") return;

    if (!tc.vars.audioCtx) {
        tc.vars.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        tc.vars.audioCtx.onstatechange = () => {
            if (tc.vars.audioCtx.state === 'running') applyState();
        };
    }

    if (!tc.vars.gainNode) createGainNode();

    try {
        log(`Attempting hook: ${element.tagName} id=${element.id || ''} src=${element.currentSrc || element.src || ''}`, 4);
        let source = null;

        if (typeof element.wrappedJSObject !== 'undefined') {
            try {
                source = tc.vars.audioCtx.createMediaElementSource(element.wrappedJSObject);
            } catch (e) {
                log(`Unwrap failed: ${e && e.message}`, 3);
            }
        }

        if (!source) {
            try {
                source = tc.vars.audioCtx.createMediaElementSource(element);
            } catch (e) {
                // createMediaElementSource can fail if the element is already connected elsewhere or due to browser restrictions
                log(`createMediaElementSource failed: ${e && e.message}`, 2);
                source = null;
            }
        }

        if (source) {
            source.connect(tc.vars.gainNode);
            tc.vars.gainNode.connect(tc.vars.audioCtx.destination);

            element.dataset.vcHooked = "true";
            // Remove any fallback adjustments we may have made earlier
            if (element.dataset.vcFallback === 'true') {
                try {
                    if (element.__vc_originalVolume !== undefined) element.volume = element.__vc_originalVolume;
                } catch (e) {}
                delete element.__vc_originalVolume;
                delete element.dataset.vcFallback;
            }

            applyState();

            if (tc.settings.debugMode) element.style.border = "2px solid #00ff00";
            else element.style.border = "";
            log("Hook Success!", 4);
        } else {
            // Fallback: if we can't create an audio node, adjust element.volume directly so user notices changes
            if (element.dataset.vcFallback !== 'true') {
                try {
                    element.__vc_originalVolume = element.volume;
                } catch (e) {}
                element.dataset.vcFallback = 'true';
            }
            // Apply current state to fallback element
            try {
                const gain = getGainValue(tc.vars.dB);
                // map gain to 0..1 for element.volume (best-effort)
                const newVol = Math.min(1, Math.max(0, gain));
                element.volume = newVol;
                if (tc.settings.debugMode) element.style.border = "2px dashed #ffa500";
            } catch (e) {
                log(`Fallback volume set failed: ${e && e.message}`, 2);
            }
            log("Hook fallback applied (element.volume scaled)", 3);
        }

    } catch (e) {
        log(`connectOutput outer failure: ${e && e.message}`, 1);
        if (tc.settings.debugMode) element.style.border = "5px solid red";
    }
} 

function init() {
    if (document.body.classList.contains("vc-init")) return;

    for (const el of document.querySelectorAll("audio, video")) connectOutput(el);

    new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1) {
                    if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') connectOutput(n);
                    else if (n.querySelectorAll) for (const el of n.querySelectorAll('audio, video')) connectOutput(el);

                    // Also check for media elements inside shadow roots (YouTube may use shadow DOM-ish patterns)
                    try {
                        if (n.shadowRoot && n.shadowRoot.querySelectorAll) {
                            for (const el of n.shadowRoot.querySelectorAll('audio, video')) connectOutput(el);
                        }
                    } catch (e) {}
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    document.addEventListener('click', () => {
        if (tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') tc.vars.audioCtx.resume().then(applyState);
    }, { passive: true });

    document.body.classList.add("vc-init");
} 

function extractRootDomain(url) {
    if (!url) return "";
    let domain = url.replace(/^(https?|ftp):\/\/(www\.)?/, '');
    domain = domain.split('/')[0].split(':')[0];
    return domain.toLowerCase();
}

function vcHostname(url) {
    if (!url) return "";
    const urlStr = String(url);
    if (urlStr.startsWith("file:")) return "Local File";
    try {
        const parsed = new URL(urlStr);
        if (parsed.protocol === "file:") return "Local File";
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ftp:") return "";
        let hostname = parsed.hostname.toLowerCase();
        if (hostname.startsWith("www.")) hostname = hostname.slice(4);
        return hostname;
    } catch (e) {
        let domain = urlStr.replace(/^(https?|ftp):\/\/(www\.)?/i, "");
        domain = domain.split("/")[0].split(":")[0];
        return domain.toLowerCase();
    }
}

function sitePathKey(url) {
    if (!url) return "";
    const urlStr = String(url);
    if (urlStr.startsWith("file:")) return "Local File";
    try {
        const parsed = new URL(urlStr);
        if (parsed.protocol === "file:") return "Local File";
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ftp:") return "";
        let hostname = parsed.hostname.toLowerCase();
        if (hostname.startsWith("www.")) hostname = hostname.slice(4);
        if (!hostname) return "";
        let pathname = parsed.pathname;
        if (!pathname || pathname === "/") return hostname;
        if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
        return hostname + pathname.toLowerCase();
    } catch (e) {
        return vcHostname(urlStr) || "";
    }
}

function rememberedEntry(siteSettings, url) {
    siteSettings = siteSettings || {};
    const pathKey = sitePathKey(url);
    const hostKey = vcHostname(url);
    if (pathKey && siteSettings[pathKey]) return siteSettings[pathKey];
    if (hostKey && siteSettings[hostKey]) return siteSettings[hostKey];
}

function anyRememberedKeyForHost(siteSettings, hostLower) {
    const host = String(hostLower || "").toLowerCase();
    if (!host) return false;
    return Object.keys(siteSettings || {}).some((key) => {
        const keyStr = String(key);
        const slashIdx = keyStr.indexOf("/");
        const hostPart = (slashIdx === -1 ? keyStr : keyStr.slice(0, slashIdx)).toLowerCase();
        return host.includes(hostPart) || hostPart.includes(host);
    });
}

function start() {
    if (!browserAPI) return;

    browserAPI.storage.local.get({ fqdns: [], whitelist: [], whitelistMode: false, siteSettings: {}, debugMode: false }, (data) => {
        if (browserAPI.runtime.lastError) return;

        if (data.debugMode !== undefined) tc.settings.debugMode = data.debugMode;

        const currentDomain = extractRootDomain(window.location.href);

        // Debug: show state used to decide blocking
        if (tc.settings.debugMode) {
            log(`start(): domain=${currentDomain} whitelistMode=${data.whitelistMode} fqdns=[${(data.fqdns||[]).slice(0,5).join(',')}] siteSettingsCount=${Object.keys(data.siteSettings||{}).length}`, 4);
        }

        let blocked = false;
        if (data.whitelistMode) {
            if (tc.settings.debugMode) log(`start(): remembered samples=[${Object.keys(data.siteSettings||{}).slice(0,5).join(',')}]`, 4);
            if (!anyRememberedKeyForHost(data.siteSettings, vcHostname(window.location.href))) blocked = true;
        } else {
            if (data.fqdns.some(d => currentDomain.includes(d))) blocked = true;
        }

        // Debug: log final decision
        if (tc.settings.debugMode) log(`start(): blocked=${blocked}`, 4);

        // Ensure the content script's blocked flag reflects the current state (clear it when unblocked)
        tc.vars.isBlocked = blocked;
        if (blocked) {
            return;
        }

        const saved = rememberedEntry(data.siteSettings, window.location.href);
        if (saved) {
            if (saved.volume !== undefined) tc.vars.dB = parseInt(saved.volume, 10) || 0;
            if (saved.mono !== undefined) tc.vars.mono = saved.mono;
        }

        init();

        // Also attempt to (re)hook any existing media elements immediately. This helps when a page
        // was previously blocked and is now allowed — ensure a gain node/source gets created.
        try {
            for (const el of document.querySelectorAll('audio, video')) {
                connectOutput(el);
            }
        } catch (e) {
            if (tc.settings.debugMode) log(`re-hook existing elements failed: ${e.message}`, 3);
        }
    });
}

if (document.readyState === "loading") {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}

// Keep content script state in sync when settings change in the extension UI
if (browserAPI && browserAPI.storage && browserAPI.storage.onChanged) {
    browserAPI.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (tc.settings.debugMode) log(`onChanged: keys=[${Object.keys(changes).join(',')}]`, 4);

        // If whitelist/blacklist mode, lists, or remembered sites changed, re-evaluate whether this page should be blocked
        if (changes.whitelistMode || changes.fqdns || changes.whitelist || changes.siteSettings) {
            start();
        }

        // If per-site settings changed, apply them if they affect this domain
        if (changes.siteSettings) {
            browserAPI.storage.local.get({ siteSettings: {} }, (data) => {
                if (browserAPI.runtime && browserAPI.runtime.lastError) return;
                const saved = rememberedEntry(data.siteSettings, window.location.href);
                if (saved) {
                    if (saved.volume !== undefined) tc.vars.dB = parseInt(saved.volume, 10) || 0;
                    if (saved.mono !== undefined) tc.vars.mono = saved.mono;
                    if (tc.settings.debugMode) log(`siteSettings updated: dB=${tc.vars.dB}, mono=${tc.vars.mono}`, 4);
                    applyState();
                    try {
                        init();
                        for (const el of document.querySelectorAll('audio, video')) connectOutput(el);
                        if (tc.vars.audioCtx && tc.vars.audioCtx.state === 'suspended') tc.vars.audioCtx.resume().then(applyState);
                    } catch (e) {
                        if (tc.settings.debugMode) log(`re-hook after siteSettings failed: ${e.message}`, 3);
                    }
                } else {
                    if (tc.settings.debugMode) log('siteSettings change did not affect this domain', 4);
                }
            });
        }

        // Update debug mode live
        if (changes.debugMode) {
            tc.settings.debugMode = !!changes.debugMode.newValue;
        }
    });
} 