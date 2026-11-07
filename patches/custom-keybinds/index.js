/*
Patch: Custom Keybinds.

Adds configurable keyboard shortcuts to Element. The default Cmd+H binding
dispatches Element's home-view action and consumes the event in the renderer,
so macOS never forwards it to the native "Hide Element" menu accelerator while
Element is focused. Bindings are edited in a "Keybinds" Settings tab and stored
locally.
*/
(() => {
    "use strict";

    const PATCH_ID = "custom-keybinds";
    const TAB_ID = "custom-keybinds";
    const PANEL_ID = `mx_tabpanel_${TAB_ID}`;
    const SETTINGS_KEY = "element-mods.custom-keybinds";
    const DEFAULT_BINDINGS = [{ combo: "Cmd+H", action: "go_home" }];
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
        "Comma",
        "Period",
        "Slash",
        "Semicolon",
        "Quote",
        "BracketLeft",
        "BracketRight",
        "Backslash",
        "Minus",
        "Equal",
        "Backquote",
    ]);
    const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

    const ACTIONS = {
        go_home: {
            label: "Go to home view",
            dialogGuard: true,
            run(dispatcher) {
                if (typeof dispatcher.dispatch !== "function") return false;
                dispatcher.dispatch({ action: "view_home_page" });
                return true;
            },
        },
        open_settings: {
            label: "Open settings",
            run(dispatcher) {
                if (typeof dispatcher.dispatch !== "function") return false;
                dispatcher.dispatch({ action: "view_user_settings" });
                return true;
            },
        },
        toggle_space_panel: {
            label: "Toggle space panel",
            run(dispatcher) {
                if (typeof dispatcher.fire !== "function") return false;
                dispatcher.fire("toggle_space_panel");
                return true;
            },
        },
        toggle_user_menu: {
            label: "Toggle user menu",
            run(dispatcher) {
                if (typeof dispatcher.fire !== "function") return false;
                dispatcher.fire("toggle_user_menu");
                return true;
            },
        },
    };

    let started = false;
    let bindings = defaultBindings();
    let recording = false;
    let recorderListener = null;
    let recorderCallback = null;
    let statusMessage = "";
    let tabRegistered = false;
    const openPanels = new Set();

    // ------------------------------------------------------------------
    // Pure combo and persistence helpers (exported through _test)
    // ------------------------------------------------------------------

    function defaultBindings() {
        return DEFAULT_BINDINGS.map((binding) => ({ ...binding }));
    }

    function keyFromEvent(event) {
        if (!event) return null;
        const code = typeof event.code === "string" ? event.code : "";
        const key = typeof event.key === "string" ? event.key : "";
        if (MODIFIER_CODES.has(code) || MODIFIER_KEYS.has(key)) return null;

        if (/^Key[A-Z]$/.test(code)) return code.slice(3);
        if (/^Digit[0-9]$/.test(code)) return code.slice(5);
        if (FUNCTION_KEY.test(code) || NAMED_CODES.has(code)) return code;

        if (!key) return null;
        return key.length === 1 ? key.toUpperCase() : key;
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

    function canonicalCombo(raw) {
        if (typeof raw !== "string" || raw.length === 0) return null;
        const parts = raw.split("+");
        const key = parts.pop();
        if (!key || MODIFIER_KEYS.has(key) || parts.length !== new Set(parts).size) return null;
        if (parts.some((part) => !MODIFIER_ORDER.includes(part))) return null;

        const wanted = new Set(parts);
        const modifiers = MODIFIER_ORDER.filter((modifier) => wanted.has(modifier));
        const bindable = modifiers.some((modifier) => modifier !== "Shift") || FUNCTION_KEY.test(key);
        if (!bindable) return null;
        return [...modifiers, key].join("+");
    }

    function normalizeBindings(rawBindings) {
        const out = [];
        const seen = new Set();
        for (const entry of rawBindings) {
            if (!entry || typeof entry !== "object") continue;
            const action = entry.action;
            if (typeof action !== "string" || !ACTIONS[action]) continue;
            const combo = canonicalCombo(entry.combo);
            if (!combo || seen.has(combo)) continue;
            seen.add(combo);
            out.push({ combo, action });
        }
        return out;
    }

    function loadBindings(storage = window.localStorage) {
        let raw = null;
        try {
            raw = storage.getItem(SETTINGS_KEY);
        } catch {
            return defaultBindings();
        }
        if (raw == null) return defaultBindings();

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return defaultBindings();
        }
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.bindings)) {
            return defaultBindings();
        }
        return normalizeBindings(parsed.bindings);
    }

    function saveBindings() {
        try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ bindings }));
        } catch {
            // Storage unavailable: keep the in-memory bindings for this session.
        }
    }

    // ------------------------------------------------------------------
    // Key handling
    // ------------------------------------------------------------------

    function dialogIsOpen() {
        try {
            return !!document.querySelector(".mx_Dialog_wrapper");
        } catch {
            return false;
        }
    }

    function runAction(actionId) {
        const action = ACTIONS[actionId];
        if (!action) return false;
        if (action.dialogGuard && dialogIsOpen()) return true;

        const dispatcher = window.mxDispatcher;
        if (!dispatcher) return false;
        try {
            return action.run(dispatcher) === true;
        } catch {
            return false;
        }
    }

    function handleKeyDown(event) {
        if (event.repeat || recording) return false;
        const combo = comboFromEvent(event);
        if (!combo) return false;
        const binding = bindings.find((entry) => entry.combo === combo);
        if (!binding || !runAction(binding.action)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
    }

    // ------------------------------------------------------------------
    // Settings tab
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

    function setRecording(value) {
        recording = !!value;
    }

    function cancelRecorder(message) {
        if (recorderListener) window.removeEventListener("keydown", recorderListener, true);
        recorderListener = null;
        recorderCallback = null;
        recording = false;
        if (message != null) statusMessage = message;
    }

    function onRecorderKeyDown(event) {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === "Escape" || event.code === "Escape") {
            cancelRecorder("Recording cancelled.");
            refreshPanels();
            return;
        }

        const combo = comboFromEvent(event);
        if (!combo) {
            statusMessage = "Press a valid shortcut: Ctrl, Alt or Cmd plus a key, or a function key.";
            refreshPanels();
            return;
        }

        const callback = recorderCallback;
        cancelRecorder("");
        const error = callback ? callback(combo) : "";
        statusMessage = error || `Saved ${combo}.`;
        refreshPanels();
    }

    function beginRecording(callback) {
        cancelRecorder();
        recorderCallback = callback;
        recorderListener = onRecorderKeyDown;
        recording = true;
        statusMessage = "Press the new shortcut. Escape cancels.";
        window.addEventListener("keydown", recorderListener, true);
        refreshPanels();
    }

    function comboInUse(combo, exceptIndex = -1) {
        return bindings.some((binding, index) => index !== exceptIndex && binding.combo === combo);
    }

    function updateBindings(nextBindings, message) {
        bindings = nextBindings;
        saveBindings();
        statusMessage = message;
        refreshPanels();
    }

    function createTabLabel() {
        const li = h("li", "mx_TabbedView_tabLabel");
        li.setAttribute("role", "tab");
        li.setAttribute("tabindex", "0");
        li.setAttribute("aria-controls", PANEL_ID);
        li.setAttribute("aria-selected", "false");
        li.setAttribute("data-testid", `settings-tab-${TAB_ID}`);

        const icon = h("span");
        icon.setAttribute("aria-hidden", "true");
        icon.style.cssText = "display:inline-flex;margin-inline-end:8px;color:var(--cpd-color-icon-primary,inherit);";
        icon.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01"/><path d="M11 10h.01"/><path d="M15 10h.01"/><path d="M7 14h10"/></svg>';
        li.appendChild(icon);
        li.appendChild(h("span", "mx_TabbedView_tabLabel_text", "Keybinds"));
        return li;
    }

    function createBindingRow(binding, index) {
        const row = h("div");
        row.style.cssText =
            "display:grid;grid-template-columns:minmax(110px,auto) 1fr auto auto;gap:8px;align-items:center;" +
            "padding:8px 10px;background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;margin-bottom:6px;";

        const combo = h("code", null, binding.combo);
        combo.style.cssText =
            "padding:2px 6px;border-radius:4px;background:var(--cpd-color-bg-canvas-default,#fff);" +
            "border:1px solid var(--cpd-color-border-disabled,#ddd);font-family:monospace;";
        row.appendChild(combo);

        const select = h("select");
        select.style.cssText =
            "min-width:0;padding:5px 8px;border-radius:6px;border:1px solid var(--cpd-color-border-disabled,#ccc);" +
            "background:transparent;color:inherit;font:inherit;";
        for (const [actionId, action] of Object.entries(ACTIONS)) {
            const option = h("option", null, action.label);
            option.value = actionId;
            select.appendChild(option);
        }
        select.value = binding.action;
        select.addEventListener("change", () => {
            const next = bindings.map((entry, entryIndex) =>
                entryIndex === index ? { ...entry, action: select.value } : entry,
            );
            updateBindings(next, "Keybind updated.");
        });
        row.appendChild(select);

        row.appendChild(
            makeButton("Change", () => {
                beginRecording((combo) => {
                    if (comboInUse(combo, index)) return `${combo} is already assigned.`;
                    const next = bindings.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, combo } : entry,
                    );
                    bindings = next;
                    saveBindings();
                    return "";
                });
            }),
        );
        row.appendChild(
            makeButton("Remove", () => {
                updateBindings(
                    bindings.filter((_, entryIndex) => entryIndex !== index),
                    `${binding.combo} removed.`,
                );
            }),
        );
        return row;
    }

    function createPanelContent() {
        const content = h("div");
        content.style.cssText = "padding:24px;max-width:720px;";

        const title = h("h3", null, "Keybinds");
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);";
        content.appendChild(title);

        const explanation = h(
            "div",
            null,
            "Cmd+H normally hides Element. Binding it here replaces that shortcut while Element is focused; Hide remains available from the menu. Add, change, or remove shortcuts below.",
        );
        explanation.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:16px;";
        content.appendChild(explanation);

        if (statusMessage) {
            const status = h("div", null, statusMessage);
            status.style.cssText = "margin-bottom:12px;color:var(--cpd-color-text-secondary,inherit);";
            content.appendChild(status);
        }

        if (bindings.length === 0) {
            const empty = h("div", null, "No keybinds configured.");
            empty.style.marginBottom = "12px";
            content.appendChild(empty);
        } else {
            bindings.forEach((binding, index) => content.appendChild(createBindingRow(binding, index)));
        }

        const controls = h("div");
        controls.style.cssText = "display:flex;gap:8px;margin-top:12px;";
        controls.appendChild(
            makeButton(
                "Add keybind",
                () => {
                    beginRecording((combo) => {
                        if (comboInUse(combo)) return `${combo} is already assigned.`;
                        bindings = [...bindings, { combo, action: "go_home" }];
                        saveBindings();
                        return "";
                    });
                },
                true,
            ),
        );
        controls.appendChild(
            makeButton("Reset to defaults", () => {
                updateBindings(defaultBindings(), "Keybinds reset to defaults.");
            }),
        );
        content.appendChild(controls);
        return content;
    }

    function createPanel() {
        const panel = h("div", "mx_TabbedView_tabPanel");
        panel.id = PANEL_ID;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", `${PANEL_ID}_label`);
        panel.setAttribute("data-custom-keybinds-panel", "true");

        const scroller = h("div", "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent");
        scroller.appendChild(createPanelContent());
        openPanels.add(scroller);
        panel.appendChild(scroller);
        return panel;
    }

    function refreshPanels() {
        for (const scroller of openPanels) {
            if (!scroller.isConnected) {
                openPanels.delete(scroller);
                continue;
            }
            scroller.textContent = "";
            scroller.appendChild(createPanelContent());
        }
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    function start() {
        if (started) return;
        started = true;
        bindings = loadBindings();
        window.addEventListener("keydown", handleKeyDown, true);
        if (window.mods && window.mods.settingsTabs) {
            window.mods.settingsTabs.register(TAB_ID, { label: createTabLabel(), renderPanel: createPanel });
            tabRegistered = true;
        }
    }

    function stop() {
        if (!started) return;
        started = false;
        cancelRecorder();
        window.removeEventListener("keydown", handleKeyDown, true);
        if (tabRegistered && window.mods.settingsTabs) window.mods.settingsTabs.unregister(TAB_ID);
        tabRegistered = false;
        openPanels.clear();
        statusMessage = "";
    }

    window.mods.registerPatch(PATCH_ID, {
        start,
        stop,
        _test: {
            comboFromEvent,
            canonicalCombo,
            loadBindings,
            handleKeyDown,
            setRecording,
        },
    });
})();
