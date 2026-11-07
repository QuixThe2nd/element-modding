/*
Patch: Custom Keybinds (v2).

Makes Element's built-in keyboard shortcuts rebindable from Element's own
Settings -> Keyboard pane: every rebindable row gains Edit (record a new key
combination) and Reset controls, plus a Reset-all control. Overrides are
applied by mutating the shared KEYBOARD_SHORTCUTS table's `.default` in place,
so Element's own key handling picks them up immediately, and are persisted in
localStorage under "element-mods.custom-keybinds" as {"overrides": {...}}.

The patch changes no default shortcuts on its own and adds no Settings tab.
*/
(() => {
    "use strict";

    const PATCH_ID = "custom-keybinds";
    const SETTINGS_KEY = "element-mods.custom-keybinds";
    const SECTION_ATTR = "data-custom-keybinds-section";
    const ROW_ATTR = "data-custom-keybinds-row";
    const STATUS_ATTR = "data-custom-keybinds-status";

    const PANE_SELECTORS = [
        "#mx_tabpanel_USER_KEYBOARD_TAB",
        ".mx_TabbedView_tabPanel:has(.mx_KeyboardShortcut_shortcutList)",
        "[class*='KeyboardUserSettingsTab']",
    ];

    const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Cmd"];
    const MODIFIER_CODES = new Set([
        "ControlLeft",
        "ControlRight",
        "AltLeft",
        "AltRight",
        "ShiftLeft",
        "ShiftRight",
        "MetaLeft",
        "MetaRight",
    ]);
    const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);
    const NAMED_CODES = new Set([
        "Escape",
        "Enter",
        "Space",
        "Tab",
        "Backspace",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
    ]);
    // Punctuation codes are stored as the characters Element sees in event.key.
    const CODE_PUNCT_CHARS = {
        Comma: ",",
        Period: ".",
        Slash: "/",
        Semicolon: ";",
        Quote: "'",
        BracketLeft: "[",
        BracketRight: "]",
        Backslash: "\\",
        Minus: "-",
        Equal: "=",
        Backquote: "`",
    };
    const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
    const KEYBINDING_FLAGS = ["ctrlKey", "altKey", "shiftKey", "metaKey", "ctrlOrCmdKey"];
    const CHUNK_GLOBAL_NAMES = [
        "webpackChunk",
        "webpackChunk_web",
        "webpackChunkwebapp",
        "webpackChunk_element_web",
        "webpackChunk_element",
    ];

    let started = false;
    let overrides = {};
    let statusMessage = "";

    let shortcutsTable = null;
    let factoryDefaults = {};

    let observer = null;
    let paneEl = null;
    let sectionEl = null;

    let recording = false;
    let recordingName = null;
    let recorderListener = null;

    let webpackRequire = null;
    let chunkHooks = []; // { arr, original, wrapped }
    let chunkWatchers = []; // { name, existing }
    let watcherValues = {};

    // ------------------------------------------------------------------
    // Combo helpers
    // ------------------------------------------------------------------

    function isMac() {
        try {
            const nav = window.navigator || {};
            return /mac|iphone|ipad|ipod/i.test(`${nav.platform || ""} ${nav.userAgent || ""}`);
        } catch {
            return false;
        }
    }

    // Display form used inside combos: letters uppercased, " " as "Space",
    // named keys (Enter, ArrowUp, F5, ...) as-is, punctuation as the char.
    function displayKey(key) {
        if (key === " ") return "Space";
        if (key.length === 1) return key.toUpperCase();
        return key;
    }

    // Element matches shortcuts against event.key; convert a display key back.
    function elementKey(display) {
        if (display === "Space") return " ";
        if (/^[A-Z]$/.test(display)) return display.toLowerCase();
        return display;
    }

    // Derive a display key from a KeyboardEvent. Layout- and Option-safe: with
    // Option held, event.key is a dead-key symbol ("˙"), so prefer event.code.
    function keyFromEvent(event) {
        if (!event) return null;
        const code = typeof event.code === "string" ? event.code : "";
        const key = typeof event.key === "string" ? event.key : "";
        if (MODIFIER_CODES.has(code) || MODIFIER_KEYS.has(key)) return null;

        if (/^Key[A-Z]$/.test(code)) return code.slice(3);
        if (/^Digit[0-9]$/.test(code)) return code.slice(5);
        if (FUNCTION_KEY.test(code) || NAMED_CODES.has(code)) return code;
        if (Object.prototype.hasOwnProperty.call(CODE_PUNCT_CHARS, code)) return CODE_PUNCT_CHARS[code];

        if (!key) return null;
        return displayKey(key);
    }

    function comboFromEvent(event) {
        const key = keyFromEvent(event);
        if (!key) return null;

        const modifiers = [];
        if (event.ctrlKey) modifiers.push("Ctrl");
        if (event.altKey) modifiers.push("Alt");
        if (event.shiftKey) modifiers.push("Shift");
        if (event.metaKey) modifiers.push("Cmd");

        const bindable = modifiers.some((modifier) => modifier !== "Shift") || FUNCTION_KEY.test(key);
        if (!bindable) return null;
        return [...modifiers, key].join("+");
    }

    // "Cmd+H" -> { metaKey: true, key: "h" } (Element's IKeybinding shape).
    function comboToKeybinding(combo) {
        if (typeof combo !== "string" || !combo) return null;
        const parts = combo.split("+");
        const display = parts.pop();
        if (!display || MODIFIER_ORDER.includes(display) || MODIFIER_KEYS.has(display)) return null;
        if (parts.length !== new Set(parts).size || parts.some((part) => !MODIFIER_ORDER.includes(part))) {
            return null;
        }

        const kbd = {};
        if (parts.includes("Ctrl")) kbd.ctrlKey = true;
        if (parts.includes("Alt")) kbd.altKey = true;
        if (parts.includes("Shift")) kbd.shiftKey = true;
        if (parts.includes("Cmd")) kbd.metaKey = true;
        kbd.key = elementKey(display);
        return kbd;
    }

    // Inverse of comboToKeybinding; resolves ctrlOrCmdKey for this platform.
    function keybindingToCombo(kbd) {
        if (!kbd || typeof kbd !== "object" || typeof kbd.key !== "string" || !kbd.key) return null;
        const mac = isMac();
        const modifiers = [];
        if (kbd.ctrlKey || (!mac && kbd.ctrlOrCmdKey)) modifiers.push("Ctrl");
        if (kbd.altKey) modifiers.push("Alt");
        if (kbd.shiftKey) modifiers.push("Shift");
        if (kbd.metaKey || (mac && kbd.ctrlOrCmdKey)) modifiers.push("Cmd");
        modifiers.push(displayKey(kbd.key));
        return modifiers.join("+");
    }

    // ------------------------------------------------------------------
    // Persistence: {"overrides": {name: {key, ...flags}}}
    // ------------------------------------------------------------------

    function normalizeKeybinding(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        if (typeof value.key !== "string" || value.key.length === 0) return null;
        const kbd = { key: value.key };
        for (const flag of KEYBINDING_FLAGS) {
            if (value[flag] === true) kbd[flag] = true;
        }
        return kbd;
    }

    function loadOverrides(storage) {
        let raw = null;
        try {
            raw = (storage || window.localStorage).getItem(SETTINGS_KEY);
        } catch {
            return {};
        }
        if (raw == null) return {};

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {};
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const stored = parsed.overrides;
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};

        const out = {};
        for (const [name, value] of Object.entries(stored)) {
            const kbd = normalizeKeybinding(value);
            if (kbd) out[name] = kbd;
        }
        return out;
    }

    function saveOverrides() {
        try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ overrides }));
        } catch {
            // Storage unavailable: keep the in-memory overrides for this session.
        }
    }

    // ------------------------------------------------------------------
    // KEYBOARD_SHORTCUTS table: discovery, in-place mutation, restore
    // ------------------------------------------------------------------

    function isRebindableEntry(entry) {
        return (
            !!entry &&
            typeof entry === "object" &&
            !!entry.default &&
            typeof entry.default === "object" &&
            typeof entry.default.key === "string" &&
            entry.default.key.length > 0
        );
    }

    function looksLikeShortcutsTable(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        let count = 0;
        for (const entry of Object.values(value)) {
            if (isRebindableEntry(entry)) count++;
        }
        return count >= 3;
    }

    // Replace every property of entry.default without changing its identity:
    // anything holding a reference to the shared table sees the new binding.
    function mutateDefault(entry, kbd) {
        const target = entry.default;
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, kbd);
    }

    function captureFactoryDefaults(table) {
        for (const [name, entry] of Object.entries(table)) {
            if (isRebindableEntry(entry) && !(name in factoryDefaults)) {
                factoryDefaults[name] = { ...entry.default };
            }
        }
    }

    function applyOverrides(table, overridesToApply) {
        if (!looksLikeShortcutsTable(table)) return [];
        captureFactoryDefaults(table);
        const applied = [];
        for (const [name, value] of Object.entries(overridesToApply || {})) {
            const kbd = normalizeKeybinding(value);
            if (!kbd || !factoryDefaults[name] || !table[name]) continue;
            mutateDefault(table[name], kbd);
            applied.push(name);
        }
        return applied;
    }

    function restoreDefaults(table) {
        if (!table) return;
        for (const [name, kbd] of Object.entries(factoryDefaults)) {
            if (table[name] && table[name].default) mutateDefault(table[name], kbd);
        }
    }

    function adoptTable(table) {
        if (shortcutsTable || !looksLikeShortcutsTable(table)) return false;
        shortcutsTable = table;
        captureFactoryDefaults(table);
        applyOverrides(table, overrides);
        return true;
    }

    // -- Webpack discovery -------------------------------------------------
    // Element does not expose KEYBOARD_SHORTCUTS globally, so grab the real
    // __webpack_require__ by pushing a probe chunk onto the app's chunk array,
    // then require the (few) module factories whose source mentions
    // "ctrlOrCmdKey" and shape-check their exports.

    function scanExports(exports) {
        if (!exports || (typeof exports !== "object" && typeof exports !== "function")) return false;
        if (looksLikeShortcutsTable(exports)) return adoptTable(exports);
        let values;
        try {
            values = Object.values(exports);
        } catch {
            return false;
        }
        for (const value of values) {
            if (looksLikeShortcutsTable(value) && adoptTable(value)) return true;
        }
        return false;
    }

    function scanWebpackModules() {
        if (shortcutsTable || !webpackRequire) return;
        const factories = webpackRequire.m;
        if (!factories || typeof factories !== "object") return;
        for (const id of Object.keys(factories)) {
            let source = "";
            try {
                source = Function.prototype.toString.call(factories[id]);
            } catch {
                continue;
            }
            if (!source.includes("ctrlOrCmdKey")) continue;
            let exports;
            try {
                exports = webpackRequire(id);
            } catch {
                continue;
            }
            try {
                if (scanExports(exports)) return;
            } catch {
                // keep looking
            }
        }
    }

    function grabWebpackRequire(arr) {
        if (webpackRequire) return;
        try {
            arr.push([
                [Symbol("element-mods.custom-keybinds")],
                {},
                (require) => {
                    webpackRequire = require;
                },
            ]);
        } catch {
            // Webpack runtime not initialised yet; the queued probe runs then.
        }
    }

    function hookChunkArray(arr) {
        if (!arr || typeof arr.push !== "function") return;
        if (chunkHooks.some((hook) => hook.arr === arr)) return;
        const original = arr.push;
        const wrapped = function (...chunks) {
            const result = original.apply(this, chunks);
            if (!shortcutsTable) {
                try {
                    scanWebpackModules();
                } catch {
                    // ignore and try again on the next chunk
                }
            }
            return result;
        };
        try {
            arr.push = wrapped;
        } catch {
            return;
        }
        chunkHooks.push({ arr, original, wrapped });
        grabWebpackRequire(arr);
        if (!shortcutsTable) {
            try {
                scanWebpackModules();
            } catch {
                // ignore
            }
        }
    }

    function installChunkWatchers() {
        let existing = [];
        try {
            existing = Object.getOwnPropertyNames(window).filter((name) => /^webpackChunk/.test(name));
        } catch {
            // ignore
        }
        const names = new Set([...CHUNK_GLOBAL_NAMES, ...existing]);
        for (const name of names) {
            let current;
            try {
                current = window[name];
            } catch {
                continue;
            }
            if (Array.isArray(current)) {
                hookChunkArray(current);
                continue;
            }
            if (current !== undefined) continue;
            const descriptor = Object.getOwnPropertyDescriptor(window, name);
            if (descriptor && descriptor.configurable === false) continue;
            try {
                Object.defineProperty(window, name, {
                    configurable: true,
                    enumerable: false,
                    get() {
                        return watcherValues[name];
                    },
                    set(value) {
                        watcherValues[name] = value;
                        if (Array.isArray(value)) hookChunkArray(value);
                    },
                });
                chunkWatchers.push({ name, existing: descriptor });
            } catch {
                // ignore
            }
        }
    }

    function stopWebpackDiscovery() {
        for (const { arr, original, wrapped } of chunkHooks) {
            try {
                if (arr.push === wrapped) arr.push = original;
            } catch {
                // ignore
            }
        }
        chunkHooks = [];
        for (const { name, existing } of chunkWatchers) {
            try {
                if (existing) {
                    Object.defineProperty(window, name, existing);
                } else {
                    const value = watcherValues[name];
                    delete window[name];
                    if (value !== undefined) {
                        Object.defineProperty(window, name, {
                            configurable: true,
                            enumerable: true,
                            writable: true,
                            value,
                        });
                    }
                }
            } catch {
                // ignore
            }
        }
        chunkWatchers = [];
        watcherValues = {};
    }

    function tryResolveTable() {
        if (shortcutsTable) return true;
        for (const candidate of [window.mxKeyboardShortcuts, window.KEYBOARD_SHORTCUTS]) {
            if (adoptTable(candidate)) break;
        }
        if (!shortcutsTable) {
            try {
                scanWebpackModules();
            } catch {
                // ignore
            }
        }
        return !!shortcutsTable;
    }

    // ------------------------------------------------------------------
    // Override actions
    // ------------------------------------------------------------------

    function labelFor(name) {
        const entry = shortcutsTable && shortcutsTable[name];
        return entry && entry.displayName != null ? String(entry.displayName) : name;
    }

    function findConflict(combo, exceptName) {
        if (!shortcutsTable) return null;
        for (const [name, entry] of Object.entries(shortcutsTable)) {
            if (name === exceptName || !isRebindableEntry(entry)) continue;
            if (keybindingToCombo(entry.default) === combo) return labelFor(name);
        }
        return null;
    }

    function setOverride(name, combo) {
        const kbd = comboToKeybinding(combo);
        if (!kbd || !factoryDefaults[name]) return false;
        overrides[name] = kbd;
        saveOverrides();
        if (shortcutsTable && shortcutsTable[name]) mutateDefault(shortcutsTable[name], kbd);
        statusMessage = `Saved ${combo} for ${labelFor(name)}.`;
        refreshSection();
        return true;
    }

    function resetOverride(name) {
        if (!(name in overrides)) return false;
        delete overrides[name];
        saveOverrides();
        if (shortcutsTable && shortcutsTable[name] && factoryDefaults[name]) {
            mutateDefault(shortcutsTable[name], factoryDefaults[name]);
        }
        const factory = keybindingToCombo(factoryDefaults[name]);
        statusMessage = `${labelFor(name)} reset to ${factory || "Element's default"}.`;
        refreshSection();
        return true;
    }

    function resetAll() {
        const had = Object.keys(overrides).length > 0;
        overrides = {};
        saveOverrides();
        restoreDefaults(shortcutsTable);
        statusMessage = had ? "All keybinds reset to Element's defaults." : "No custom keybinds to reset.";
        refreshSection();
        return had;
    }

    // ------------------------------------------------------------------
    // Recorder
    // ------------------------------------------------------------------

    function cancelRecorder(message) {
        if (recorderListener) {
            try {
                window.removeEventListener("keydown", recorderListener, true);
            } catch {
                // ignore
            }
        }
        recorderListener = null;
        recordingName = null;
        recording = false;
        if (message != null) statusMessage = message;
    }

    function onRecorderKeyDown(event) {
        if (event.repeat) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();

        if (event.key === "Escape" || event.code === "Escape") {
            cancelRecorder("Recording cancelled.");
            refreshSection();
            return;
        }

        const combo = comboFromEvent(event);
        if (!combo) {
            statusMessage = "Press a valid shortcut: Ctrl, Alt or Cmd plus a key, or a function key.";
            refreshSection();
            return;
        }

        const conflict = findConflict(combo, recordingName);
        if (conflict) {
            cancelRecorder(`${combo} is already assigned to ${conflict}.`);
            refreshSection();
            return;
        }

        const name = recordingName;
        cancelRecorder();
        setOverride(name, combo);
    }

    function beginRecording(name) {
        if (!started || !factoryDefaults[name]) return false;
        cancelRecorder();
        recording = true;
        recordingName = name;
        recorderListener = onRecorderKeyDown;
        statusMessage = `Press the new shortcut for ${labelFor(name)}. Escape cancels.`;
        window.addEventListener("keydown", recorderListener, true);
        refreshSection();
        return true;
    }

    // ------------------------------------------------------------------
    // Keyboard pane augmentation
    // ------------------------------------------------------------------

    function h(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function makeButton(label, onClick, primary) {
        const button = h("button", null, label);
        button.type = "button";
        button.style.cssText =
            "padding:4px 10px;border-radius:6px;cursor:pointer;font:inherit;" +
            (primary
                ? "border:none;background:var(--cpd-color-bg-action-primary,#0dbd8b);color:#fff;"
                : "border:1px solid var(--cpd-color-border-disabled,#ccc);background:transparent;color:inherit;");
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    function buildRow(name) {
        const entry = shortcutsTable[name];
        const overridden = name in overrides;
        const isRecordingRow = recording && recordingName === name;

        const row = h("div");
        row.setAttribute(ROW_ATTR, name);
        row.style.cssText =
            "display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;" +
            "padding:6px 0;border-bottom:1px solid var(--cpd-color-border-disabled,#333);";

        row.appendChild(h("span", null, labelFor(name)));

        const combo = h("code", null, keybindingToCombo(entry.default) || "—");
        combo.style.cssText =
            "padding:2px 6px;border-radius:4px;font-family:monospace;" +
            (overridden
                ? "background:var(--cpd-color-bg-accent-rest,rgba(11,189,139,0.15));" +
                  "color:var(--cpd-color-text-accent-rest,inherit);"
                : "background:var(--cpd-color-bg-subtle-secondary,transparent);");
        row.appendChild(combo);

        row.appendChild(makeButton(isRecordingRow ? "Press keys…" : "Edit", () => beginRecording(name), isRecordingRow));
        if (overridden) row.appendChild(makeButton("Reset", () => resetOverride(name)));
        return row;
    }

    function buildSection() {
        const section = h("div");
        section.setAttribute(SECTION_ATTR, PATCH_ID);
        section.style.cssText =
            "margin-top:24px;padding-top:16px;border-top:1px solid var(--cpd-color-border-disabled,#333);";

        const title = h("h4", null, "Custom keybinds");
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-sm-semibold,600 14px/1.4 sans-serif);";
        section.appendChild(title);

        const explanation = h(
            "div",
            null,
            "Rebind Element's shortcuts: click Edit and press the new key combination. Changes apply " +
                "immediately and are stored locally. Reset restores Element's default for that shortcut.",
        );
        explanation.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:12px;";
        section.appendChild(explanation);

        if (statusMessage) {
            const status = h("div", null, statusMessage);
            status.setAttribute(STATUS_ATTR, "true");
            status.style.cssText = "margin-bottom:12px;color:var(--cpd-color-text-secondary,inherit);";
            section.appendChild(status);
        }

        for (const [name, entry] of Object.entries(shortcutsTable)) {
            if (isRebindableEntry(entry)) section.appendChild(buildRow(name));
        }

        const controls = h("div");
        controls.style.cssText = "display:flex;gap:8px;margin-top:12px;";
        controls.appendChild(makeButton("Reset all to defaults", () => resetAll()));
        section.appendChild(controls);
        return section;
    }

    function findKeyboardPane() {
        for (const selector of PANE_SELECTORS) {
            try {
                const el = document.querySelector(selector);
                if (el) return el;
            } catch {
                // ignore
            }
        }
        return null;
    }

    function sync() {
        if (!started) return;
        if (!shortcutsTable) tryResolveTable();
        paneEl = findKeyboardPane();
        if (!paneEl || !shortcutsTable) return;
        if (!sectionEl || !sectionEl.isConnected) {
            sectionEl = buildSection();
            paneEl.appendChild(sectionEl);
        }
    }

    function refreshSection() {
        if (!paneEl || !sectionEl || !sectionEl.isConnected || !shortcutsTable) return;
        const next = buildSection();
        sectionEl.remove();
        paneEl.appendChild(next);
        sectionEl = next;
    }

    function startObserver() {
        const ObserverCtor = window.MutationObserver;
        if (typeof ObserverCtor !== "function" || !document.body) return;
        observer = new ObserverCtor(() => sync());
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    function start() {
        if (started) return;
        started = true;
        overrides = loadOverrides();
        tryResolveTable();
        installChunkWatchers();
        startObserver();
        sync();
    }

    function stop() {
        if (!started) return;
        started = false;
        cancelRecorder();
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (sectionEl) {
            sectionEl.remove();
            sectionEl = null;
        }
        paneEl = null;
        restoreDefaults(shortcutsTable);
        stopWebpackDiscovery();
        shortcutsTable = null;
        factoryDefaults = {};
        webpackRequire = null;
        statusMessage = "";
    }

    window.mods.registerPatch(PATCH_ID, {
        start,
        stop,
        _test: {
            comboFromEvent,
            comboToKeybinding,
            keybindingToCombo,
            loadOverrides,
            applyOverrides,
            restoreDefaults,
            isRebindableEntry,
            looksLikeShortcutsTable,
            beginRecording,
            cancelRecording: () => cancelRecorder(),
            isRecording: () => recording,
            getStatus: () => statusMessage,
            getOverrides: () => JSON.parse(JSON.stringify(overrides)),
            setOverride,
            resetOverride,
            resetAll,
            sync,
            findKeyboardPane,
        },
    });
})();
