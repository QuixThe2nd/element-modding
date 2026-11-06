/*
Element-Mods runtime loader.
Injected into the webapp index.html as mods/loader.js. Runs in the page's
main world, exposes a small patch API on window.mods, and loads every patch
listed in mods/manifest.json as an ordered <script>.

Patches register themselves with registerPatch() but are NOT auto-started by
default: the loader starts a patch only if it is marked "required" in the
manifest (e.g. the Modding tab itself), or if its id is in the persisted
enabled set (localStorage key "element-mods.enabled"). setPatchEnabled() toggles
a patch live (start/stop) and persists the change; reload() reloads the webapp
so the whole set is re-applied from scratch. A global pause (localStorage key
"element-mods.paused") stops every non-required patch while keeping required
ones (like the Modding tab) alive so the UI can always recover.

The loader also hosts a shared "settings tabs" coordinator (window.mods.settingsTabs)
so multiple patches can each contribute a tab to the Settings dialog without
fighting over the TabbedView.
*/
(() => {
    "use strict";

    const LOG_PREFIX = "[element-mods]";
    const ENABLED_KEY = "element-mods.enabled";
    const PAUSED_KEY = "element-mods.paused";

    const registry = new Map(); // id -> { start, stop, started }
    let manifest = null;

    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    function readEnabled() {
        try {
            const raw = localStorage.getItem(ENABLED_KEY);
            if (raw === null) {
                // DEFAULT OFF: message-logger destabilizes the renderer under
                // real message load (V8 recompile churn + crashes, 2026-11-06).
                return new Set();
            }
            return new Set(JSON.parse(raw));
        } catch {
            return new Set();
        }
    }

    function writeEnabled(enabled) {
        try {
            localStorage.setItem(ENABLED_KEY, JSON.stringify([...enabled]));
        } catch (err) {
            console.error(LOG_PREFIX, "failed to persist enabled patches", err);
        }
    }

    function readPaused() {
        try {
            return JSON.parse(localStorage.getItem(PAUSED_KEY) || "false") === true;
        } catch {
            return false;
        }
    }

    function writePaused(value) {
        try {
            localStorage.setItem(PAUSED_KEY, JSON.stringify(value === true));
        } catch (err) {
            console.error(LOG_PREFIX, "failed to persist paused state", err);
        }
    }

    const enabled = readEnabled();
    let paused = readPaused();

    function isRequired(id) {
        if (!manifest || !Array.isArray(manifest.patches)) return false;
        return manifest.patches.some((p) => p.id === id && p.required);
    }

    function startPatch(id) {
        const def = registry.get(id);
        if (!def || def.started) return;
        try {
            def.start();
            def.started = true;
            log(`patch "${id}" started`);
        } catch (err) {
            console.error(LOG_PREFIX, `patch "${id}" start() threw`, err);
        }
    }

    function stopPatch(id) {
        const def = registry.get(id);
        if (!def || !def.started) return;
        if (typeof def.stop === "function") {
            try {
                def.stop();
            } catch (err) {
                console.error(LOG_PREFIX, `patch "${id}" stop() threw`, err);
            }
        }
        def.started = false;
        log(`patch "${id}" stopped`);
    }

    // ------------------------------------------------------------------
    // Shared settings-tab coordinator.
    //
    // Patches call settingsTabs.register(id, { label, renderPanel }) to add a
    // tab to the Settings dialog and settingsTabs.unregister(id) to remove it.
    // The coordinator injects labels/panels into the Compound TabbedView and
    // keeps them in sync with React's own re-renders.
    // ------------------------------------------------------------------
    const settingsTabs = (() => {
        const SETTINGS_SELECTOR = ".mx_UserSettingsDialog";
        const TABLIST_SELECTOR = ".mx_TabbedView_tabLabels";

        const tabs = new Map(); // id -> { id, label, renderPanel }
        let activeId = null;
        let observer = null;

        function getReactPanel(dialog) {
            return dialog.querySelector(".mx_TabbedView_tabPanel:not([data-mods-panel])");
        }

        function sync() {
            const dialog = document.querySelector(SETTINGS_SELECTOR);
            if (!dialog) {
                activeId = null;
                return;
            }
            const tabList = dialog.querySelector(TABLIST_SELECTOR);
            if (!tabList) return;

            // (Re)inject every registered label if React has wiped it.
            for (const tab of tabs.values()) {
                if (!tabList.querySelector(`[data-mods-tab="${tab.id}"]`)) {
                    tabList.appendChild(tab.label);
                }
            }

            // Active styling on the labels.
            for (const tab of tabs.values()) {
                const label = tabList.querySelector(`[data-mods-tab="${tab.id}"]`);
                if (!label) continue;
                const isActive = activeId === tab.id;
                label.classList.toggle("mx_TabbedView_tabLabel_active", isActive);
                label.setAttribute("aria-selected", String(isActive));
            }
            if (activeId) {
                for (const label of tabList.querySelectorAll(".mx_TabbedView_tabLabel")) {
                    if (!label.hasAttribute("data-mods-tab")) label.classList.remove("mx_TabbedView_tabLabel_active");
                }
            }

            // Show the active custom panel (creating it on demand) and hide
            // React's panel, or the other way around when none is active.
            const reactPanel = getReactPanel(dialog);
            for (const panel of dialog.querySelectorAll("[data-mods-panel]")) {
                panel.style.display = "none";
            }
            if (activeId) {
                let panel = dialog.querySelector(`[data-mods-panel="${activeId}"]`);
                if (!panel) {
                    const tab = tabs.get(activeId);
                    panel = tab.renderPanel();
                    panel.setAttribute("data-mods-panel", activeId);
                    tabList.after(panel);
                }
                panel.style.display = "";
                if (reactPanel) reactPanel.style.display = "none";
            } else {
                if (reactPanel) reactPanel.style.display = "";
            }
        }

        function onClick(event) {
            const dialog = document.querySelector(SETTINGS_SELECTOR);
            if (!dialog || !dialog.contains(event.target)) return;

            const custom = event.target.closest("[data-mods-tab]");
            if (custom) {
                activeId = custom.getAttribute("data-mods-tab");
                sync();
                return;
            }

            if (event.target.closest(".mx_TabbedView_tabLabel")) {
                activeId = null;
                sync();
            }
        }

        function ensureObserver() {
            if (observer) return;
            observer = new MutationObserver(sync);
            observer.observe(document.body, { childList: true, subtree: true });
            document.addEventListener("click", onClick);
        }

        function register(id, def) {
            if (!id || !def || tabs.has(id)) return;
            def.label.setAttribute("data-mods-tab", id);
            tabs.set(id, { id, label: def.label, renderPanel: def.renderPanel });
            ensureObserver();
            sync();
        }

        function unregister(id) {
            if (!tabs.has(id)) return;
            tabs.delete(id);
            document.querySelectorAll(`[data-mods-tab="${id}"], [data-mods-panel="${id}"]`).forEach((n) => n.remove());
            if (activeId === id) activeId = null;
            if (tabs.size === 0 && observer) {
                observer.disconnect();
                observer = null;
                document.removeEventListener("click", onClick);
            }
            sync();
        }

        return { register, unregister };
    })();

    const api = {
        // Info about the modding platform itself (name + version).
        getModInfo() {
            return manifest ? manifest.mod : null;
        },

        // Full metadata for every bundled patch (id, name, version, ...).
        getPatches() {
            return manifest && Array.isArray(manifest.patches) ? manifest.patches : [];
        },

        isPatchEnabled(id) {
            return isRequired(id) || enabled.has(id);
        },

        isPaused() {
            return paused;
        },

        // Global pause: true stops every started non-required patch (required
        // patches stay alive so the UI can recover); false restarts exactly
        // the persisted enabled set. The flag itself is persisted.
        setPaused(value) {
            paused = value === true;
            writePaused(paused);
            if (paused) {
                for (const [id, def] of registry) {
                    if (def.started && !isRequired(id)) stopPatch(id);
                }
            } else {
                for (const id of enabled) {
                    if (registry.has(id) && !isRequired(id)) startPatch(id);
                }
            }
        },

        // Toggle a patch live and persist. Returns false if the patch is unknown
        // or required (required patches are always enabled).
        setPatchEnabled(id, value) {
            if (!registry.has(id)) return false;
            if (isRequired(id)) return false;
            if (value) {
                enabled.add(id);
                // While paused the enabled set is the source of truth; the
                // patch is started on unpause (or next boot), not now.
                writeEnabled(enabled); // persist BEFORE start: a crash in start() must not lose the toggle
                if (!paused) startPatch(id);
            } else {
                enabled.delete(id);
                stopPatch(id);
                writeEnabled(enabled);
            }
            return true;
        },

        // Re-apply everything from scratch (reloads the webapp).
        reload() {
            window.location.reload();
        },

        registerPatch(id, definition) {
            if (!id || typeof definition !== "object") {
                console.error(LOG_PREFIX, "registerPatch called with invalid arguments", id);
                return;
            }
            if (registry.has(id)) {
                console.warn(LOG_PREFIX, `patch "${id}" already registered; skipping`);
                return;
            }
            registry.set(id, { start: definition.start, stop: definition.stop, started: false });
            log(`patch "${id}" loaded`);
        },

        settingsTabs,
    };

    Object.defineProperty(window, "mods", {
        value: api,
        writable: false,
        configurable: true,
    });

    function loadScript(src) {
        return new Promise((resolve) => {
            const script = document.createElement("script");
            script.src = src;
            script.async = false;
            script.onload = () => resolve(true);
            script.onerror = () => {
                console.error(LOG_PREFIX, `failed to load ${src}`);
                resolve(false);
            };
            document.body.appendChild(script);
        });
    }

    async function init() {
        try {
            const res = await fetch("mods/manifest.json", { cache: "no-store" });
            manifest = await res.json();
        } catch (err) {
            console.error(LOG_PREFIX, "failed to load mods/manifest.json", err);
            return;
        }

        const entries = Array.isArray(manifest.patches) ? manifest.patches : [];
        for (const entry of entries) {
            await loadScript(`mods/patches/${entry.id}.js`);
        }

        for (const entry of entries) {
            // While paused only required patches run; the enabled set is
            // restored by setPaused(false).
            if (isRequired(entry.id) || (!paused && enabled.has(entry.id))) startPatch(entry.id);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();
