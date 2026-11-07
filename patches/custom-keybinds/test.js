// Self-check for the custom-keybinds patch (v2).
//
// v2 design: no default shortcut changes, no separate Settings tab. The patch
// finds Element's shared KEYBOARD_SHORTCUTS table, applies user overrides by
// mutating each entry's `.default` in place, persists overrides in localStorage
// under "element-mods.custom-keybinds" as {"overrides": {...}}, and augments
// Element's built-in Settings -> Keyboard pane with Edit/record/Reset per
// rebindable row plus a Reset-all control.
//
// Run: node patches/custom-keybinds/test.js
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const STORAGE_KEY = "element-mods.custom-keybinds";
const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

// ---------------------------------------------------------------------
// Tiny fake DOM (just enough for the Keyboard pane augmentation)
// ---------------------------------------------------------------------
class FakeElement {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.parent = null;
        this.attributes = {};
        this.style = {};
        this.className = "";
        this.id = "";
        this._text = "";
        this._handlers = {};
        this._connected = false;
    }

    get isConnected() {
        return this._connected;
    }

    set textContent(value) {
        this._text = String(value);
        this.children = [];
    }

    get textContent() {
        return this._text + this.children.map((child) => child.textContent).join("");
    }

    appendChild(child) {
        child.parent = this;
        child._connected = this._connected;
        this.children.push(child);
        return child;
    }

    remove() {
        if (this.parent) {
            this.parent.children = this.parent.children.filter((child) => child !== this);
            this.parent = null;
        }
        this._connected = false;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return name in this.attributes ? this.attributes[name] : null;
    }

    hasAttribute(name) {
        return name in this.attributes;
    }

    addEventListener(type, fn) {
        (this._handlers[type] ||= []).push(fn);
    }

    removeEventListener(type, fn) {
        this._handlers[type] = (this._handlers[type] || []).filter((f) => f !== fn);
    }

    click() {
        for (const fn of this._handlers.click || []) {
            fn({ preventDefault() {}, stopPropagation() {} });
        }
    }
}

function walk(el, fn) {
    fn(el);
    for (const child of el.children) walk(child, fn);
}

function findAllByAttr(root, attr) {
    const out = [];
    walk(root, (el) => {
        if (el instanceof FakeElement && el.hasAttribute(attr)) out.push(el);
    });
    return out;
}

function findByAttr(root, attr) {
    return findAllByAttr(root, attr)[0] || null;
}

function findButton(root, label) {
    let found = null;
    walk(root, (el) => {
        if (!found && el instanceof FakeElement && el.tagName === "BUTTON" && el.textContent === label) found = el;
    });
    return found;
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
function fakeTable() {
    return {
        "Keybind.goToHome": {
            default: { ctrlOrCmdKey: true, shiftKey: true, key: "h" },
            displayName: "Go to home view",
        },
        "Keybind.openUserSettings": {
            default: { ctrlOrCmdKey: true, key: "," },
            displayName: "Open settings",
        },
        "Keybind.toggleSpacePanel": {
            default: { ctrlOrCmdKey: true, shiftKey: true, key: "d" },
            displayName: "Toggle the space panel",
        },
        "Keybind.sendMessage": {
            default: { key: "Enter" },
            displayName: "Send a message",
        },
        "Keybind.broken": { displayName: "Not a real shortcut" },
    };
}

function makeStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    const writes = [];
    return {
        data,
        writes,
        getItem(key) {
            return data.has(key) ? data.get(key) : null;
        },
        setItem(key, value) {
            writes.push([key, String(value)]);
            data.set(key, String(value));
        },
        removeItem(key) {
            data.delete(key);
        },
    };
}

function keyEvent(props) {
    return {
        repeat: false,
        prevented: false,
        stopped: false,
        preventDefault() {
            this.prevented = true;
        },
        stopPropagation() {
            this.stopped = true;
        },
        ...props,
    };
}

function loadPatch({ stored = {}, mac = true, table, pane = false } = {}) {
    let registered = null;
    const listeners = [];
    const observerInstances = [];
    const tabCalls = [];
    const storage = makeStorage(stored);
    const paneEl = pane ? new FakeElement("div") : null;
    const body = new FakeElement("body");
    body._connected = true;
    if (paneEl) {
        paneEl.className = "mx_SettingsTab mx_KeyboardUserSettingsTab";
        body.appendChild(paneEl);
    }

    class FakeMutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.disconnected = false;
            observerInstances.push(this);
        }
        observe(target, options) {
            this.observing = { target, options };
        }
        disconnect() {
            this.disconnected = true;
        }
    }

    const window = {
        mods: {
            registerPatch(id, def) {
                registered = { id, def };
            },
            settingsTabs: {
                register(...args) {
                    tabCalls.push(args);
                },
                unregister() {},
            },
        },
        localStorage: storage,
        navigator: {
            platform: mac ? "MacIntel" : "Win32",
            userAgent: mac ? "Mozilla/5.0 (Macintosh; Intel Mac OS X)" : "Mozilla/5.0 (Windows NT 10.0)",
        },
        MutationObserver: FakeMutationObserver,
        addEventListener(type, listener, options) {
            listeners.push({ type, listener, capture: options === true || options?.capture === true });
        },
        removeEventListener(type, listener, options) {
            const capture = options === true || options?.capture === true;
            const index = listeners.findIndex(
                (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
            );
            if (index !== -1) listeners.splice(index, 1);
        },
    };
    if (table) window.mxKeyboardShortcuts = table;
    const document = {
        body,
        createElement: (tag) => new FakeElement(tag),
        querySelector(selector) {
            if (paneEl && /KeyboardUserSettings/.test(selector)) return paneEl;
            return null;
        },
        querySelectorAll() {
            return [];
        },
    };
    const sandbox = { window, document, console };
    window.window = window;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    return { registered, listeners, storage, tabCalls, observerInstances, paneEl, body };
}

// ---------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------
{
    const { registered } = loadPatch();
    assert.ok(registered, "patch should register");
    assert.strictEqual(registered.id, "custom-keybinds");
    assert.strictEqual(typeof registered.def.start, "function");
    assert.strictEqual(typeof registered.def.stop, "function");
    assert.ok(registered.def._test, "patch should expose _test helpers");
}

const t = loadPatch().registered.def._test;
for (const helper of [
    "comboFromEvent",
    "comboToKeybinding",
    "keybindingToCombo",
    "loadOverrides",
    "applyOverrides",
    "restoreDefaults",
    "beginRecording",
    "isRecording",
    "getStatus",
    "getOverrides",
    "resetAll",
    "sync",
]) {
    assert.strictEqual(typeof t[helper], "function", `_test.${helper} should be a function`);
}

// ---------------------------------------------------------------------
// 2. comboFromEvent
// ---------------------------------------------------------------------
assert.strictEqual(t.comboFromEvent({ metaKey: true, code: "KeyH", key: "h" }), "Cmd+H");
assert.strictEqual(t.comboFromEvent({ ctrlKey: true, shiftKey: true, code: "KeyH", key: "h" }), "Ctrl+Shift+H");
assert.strictEqual(t.comboFromEvent({ altKey: true, metaKey: true, code: "KeyH", key: "˙" }), "Alt+Cmd+H");
assert.strictEqual(t.comboFromEvent({ metaKey: true, code: "MetaLeft", key: "Meta" }), null);
assert.strictEqual(t.comboFromEvent({ code: "KeyH", key: "h" }), null, "plain typing is not bindable");
assert.strictEqual(t.comboFromEvent({ code: "F5", key: "F5" }), "F5");
assert.strictEqual(t.comboFromEvent({ ctrlKey: true, code: "Comma", key: "," }), "Ctrl+,");
assert.strictEqual(t.comboFromEvent({ metaKey: true, code: "Space", key: " " }), "Cmd+Space");

// ---------------------------------------------------------------------
// 3. combo <-> Element keybinding conversion
// ---------------------------------------------------------------------
assert.deepEqual(t.comboToKeybinding("Cmd+H"), { metaKey: true, key: "h" });
assert.deepEqual(t.comboToKeybinding("Ctrl+Shift+H"), { ctrlKey: true, shiftKey: true, key: "h" });
assert.deepEqual(t.comboToKeybinding("Alt+Cmd+1"), { altKey: true, metaKey: true, key: "1" });
assert.deepEqual(t.comboToKeybinding("F5"), { key: "F5" });
assert.deepEqual(t.comboToKeybinding("Ctrl+,"), { ctrlKey: true, key: "," });
assert.deepEqual(t.comboToKeybinding("Cmd+Space"), { metaKey: true, key: " " });
assert.strictEqual(t.comboToKeybinding("Cmd"), null);
assert.strictEqual(t.comboToKeybinding("Nope+H"), null);

// Round trips.
for (const combo of ["Cmd+H", "Ctrl+Shift+H", "Alt+Cmd+1", "F5", "Ctrl+,", "Cmd+Space"]) {
    assert.strictEqual(t.keybindingToCombo(t.comboToKeybinding(combo)), combo, `round trip ${combo}`);
}

// ctrlOrCmdKey resolves per platform.
assert.strictEqual(t.keybindingToCombo({ ctrlOrCmdKey: true, shiftKey: true, key: "h" }), "Shift+Cmd+H");
assert.strictEqual(t.keybindingToCombo({ key: "Enter" }), "Enter");
assert.strictEqual(t.keybindingToCombo({ ctrlOrCmdKey: true, key: "," }), "Cmd+,");
{
    const win = loadPatch({ mac: false }).registered.def._test;
    assert.strictEqual(win.keybindingToCombo({ ctrlOrCmdKey: true, shiftKey: true, key: "h" }), "Ctrl+Shift+H");
}

// ---------------------------------------------------------------------
// 4. loadOverrides: persistence shape is {"overrides": {...}}
// ---------------------------------------------------------------------
const store = (value) => ({ getItem: () => value });
assert.deepEqual(t.loadOverrides(store(null)), {});
assert.deepEqual(t.loadOverrides(store("{not json")), {});
assert.deepEqual(
    t.loadOverrides(store(JSON.stringify({ bindings: [{ combo: "Cmd+H", action: "go_home" }] }))),
    {},
    "v1 storage shape must not be carried over",
);
assert.deepEqual(t.loadOverrides(store(JSON.stringify({ overrides: [] }))), {});
assert.deepEqual(t.loadOverrides(store(JSON.stringify({ overrides: {} }))), {});
assert.deepEqual(
    t.loadOverrides(
        store(
            JSON.stringify({
                overrides: {
                    "Keybind.goToHome": { key: "h", metaKey: true },
                    "Keybind.missingKey": { metaKey: true },
                    "Keybind.emptyKey": { key: "" },
                    "Keybind.notAnObject": "Cmd+H",
                    "Keybind.trimmed": { key: "s", ctrlKey: true, shiftKey: false, nonsense: 1 },
                },
            }),
        ),
    ),
    {
        "Keybind.goToHome": { key: "h", metaKey: true },
        "Keybind.trimmed": { key: "s", ctrlKey: true },
    },
);

// ---------------------------------------------------------------------
// 5. applyOverrides mutates `.default` in place
// ---------------------------------------------------------------------
{
    const table = fakeTable();
    const ref = table["Keybind.goToHome"].default;
    const applied = t.applyOverrides(table, {
        "Keybind.goToHome": { metaKey: true, key: "h" },
        "Keybind.noSuchShortcut": { key: "x", ctrlKey: true },
    });
    assert.deepEqual(applied, ["Keybind.goToHome"]);
    assert.strictEqual(table["Keybind.goToHome"].default, ref, "the same .default object must be mutated in place");
    assert.deepEqual(ref, { metaKey: true, key: "h" });

    t.restoreDefaults(table);
    assert.strictEqual(table["Keybind.goToHome"].default, ref, "restore must also be in place");
    assert.deepEqual(ref, { ctrlOrCmdKey: true, shiftKey: true, key: "h" });
}

// ---------------------------------------------------------------------
// 6. start(): applies persisted overrides, adds no tab and no key handler
// ---------------------------------------------------------------------
{
    const table = fakeTable();
    const state = loadPatch({
        table,
        stored: { [STORAGE_KEY]: JSON.stringify({ overrides: { "Keybind.goToHome": { metaKey: true, key: "h" } } }) },
    });
    const { def } = state.registered;
    def.start();
    assert.deepEqual(table["Keybind.goToHome"].default, { metaKey: true, key: "h" });
    assert.strictEqual(state.tabCalls.length, 0, "v2 must not register a Settings tab");
    assert.strictEqual(
        state.listeners.filter((entry) => entry.type === "keydown").length,
        0,
        "v2 adds no global key handler while idle",
    );
    assert.strictEqual(state.observerInstances.length, 1, "start should watch the DOM for the Keyboard pane");
    def.stop();
    assert.deepEqual(
        table["Keybind.goToHome"].default,
        { ctrlOrCmdKey: true, shiftKey: true, key: "h" },
        "stop() must restore Element's factory defaults",
    );
    assert.strictEqual(state.observerInstances[0].disconnected, true, "stop() must disconnect the observer");
}

// With no stored overrides the table must be left untouched.
{
    const table = fakeTable();
    const before = JSON.stringify(table);
    const state = loadPatch({ table });
    state.registered.def.start();
    assert.strictEqual(JSON.stringify(table), before, "no default shortcut changes");
    state.registered.def.stop();
}

// ---------------------------------------------------------------------
// 7. Recording a new combo
// ---------------------------------------------------------------------
{
    const table = fakeTable();
    const state = loadPatch({ table });
    const { def } = state.registered;
    def.start();

    assert.strictEqual(def._test.beginRecording("Keybind.toggleSpacePanel"), true);
    assert.strictEqual(def._test.isRecording(), true);
    const recorder = state.listeners.find((entry) => entry.type === "keydown" && entry.capture === true);
    assert.ok(recorder, "recording adds a capture-phase keydown listener");

    // Plain keys are rejected and keep the recorder waiting.
    const plain = keyEvent({ code: "KeyH", key: "h" });
    recorder.listener(plain);
    assert.strictEqual(def._test.isRecording(), true);
    assert.match(def._test.getStatus(), /valid shortcut/i);

    const event = keyEvent({ metaKey: true, code: "KeyH", key: "h" });
    recorder.listener(event);
    assert.strictEqual(event.prevented, true);
    assert.strictEqual(event.stopped, true);
    assert.strictEqual(def._test.isRecording(), false);
    assert.deepEqual(table["Keybind.toggleSpacePanel"].default, { metaKey: true, key: "h" });
    assert.deepEqual(def._test.getOverrides(), { "Keybind.toggleSpacePanel": { metaKey: true, key: "h" } });

    const lastWrite = state.storage.writes.at(-1);
    assert.strictEqual(lastWrite[0], STORAGE_KEY);
    assert.deepEqual(JSON.parse(lastWrite[1]), {
        overrides: { "Keybind.toggleSpacePanel": { metaKey: true, key: "h" } },
    });
    assert.strictEqual(
        state.listeners.filter((entry) => entry.type === "keydown").length,
        0,
        "recorder must remove its listener when done",
    );
    def.stop();
}

// Escape cancels recording without persisting anything.
{
    const table = fakeTable();
    const state = loadPatch({ table });
    const { def } = state.registered;
    def.start();
    def._test.beginRecording("Keybind.toggleSpacePanel");
    const recorder = state.listeners.find((entry) => entry.type === "keydown" && entry.capture === true);
    const event = keyEvent({ key: "Escape", code: "Escape" });
    recorder.listener(event);
    assert.strictEqual(event.prevented, true);
    assert.strictEqual(def._test.isRecording(), false);
    assert.strictEqual(state.storage.writes.length, 0);
    assert.deepEqual(table["Keybind.toggleSpacePanel"].default, { ctrlOrCmdKey: true, shiftKey: true, key: "d" });
    def.stop();
}

// A combo already used by another shortcut is refused with an inline message.
{
    const table = fakeTable();
    const state = loadPatch({ table });
    const { def } = state.registered;
    def.start();
    def._test.beginRecording("Keybind.toggleSpacePanel");
    const recorder = state.listeners.find((entry) => entry.type === "keydown" && entry.capture === true);
    const event = keyEvent({ metaKey: true, shiftKey: true, code: "KeyH", key: "H" });
    recorder.listener(event);
    assert.strictEqual(event.prevented, true);
    assert.strictEqual(def._test.isRecording(), false);
    assert.match(def._test.getStatus(), /already assigned/i);
    assert.strictEqual(state.storage.writes.length, 0, "conflicting overrides must not persist");
    assert.deepEqual(table["Keybind.toggleSpacePanel"].default, { ctrlOrCmdKey: true, shiftKey: true, key: "d" });
    def.stop();
}

// ---------------------------------------------------------------------
// 8. Reset-all
// ---------------------------------------------------------------------
{
    const table = fakeTable();
    const state = loadPatch({
        table,
        stored: {
            [STORAGE_KEY]: JSON.stringify({
                overrides: {
                    "Keybind.goToHome": { metaKey: true, key: "h" },
                    "Keybind.openUserSettings": { ctrlKey: true, altKey: true, key: "s" },
                },
            }),
        },
    });
    const { def } = state.registered;
    def.start();
    assert.deepEqual(table["Keybind.goToHome"].default, { metaKey: true, key: "h" });
    assert.deepEqual(table["Keybind.openUserSettings"].default, { ctrlKey: true, altKey: true, key: "s" });

    def._test.resetAll();
    assert.deepEqual(def._test.getOverrides(), {});
    assert.deepEqual(table["Keybind.goToHome"].default, { ctrlOrCmdKey: true, shiftKey: true, key: "h" });
    assert.deepEqual(table["Keybind.openUserSettings"].default, { ctrlOrCmdKey: true, key: "," });
    const lastWrite = state.storage.writes.at(-1);
    assert.strictEqual(lastWrite[0], STORAGE_KEY);
    assert.deepEqual(JSON.parse(lastWrite[1]), { overrides: {} });
    def.stop();
}

// ---------------------------------------------------------------------
// 9. Keyboard pane augmentation: Edit/record/Reset per row + Reset-all
// ---------------------------------------------------------------------
{
    const table = fakeTable();
    const state = loadPatch({
        table,
        pane: true,
        stored: { [STORAGE_KEY]: JSON.stringify({ overrides: { "Keybind.goToHome": { metaKey: true, key: "h" } } }) },
    });
    const { def } = state.registered;
    def.start();
    def._test.sync();

    const section = findByAttr(state.paneEl, "data-custom-keybinds-section");
    assert.ok(section, "the Keyboard pane should gain a custom-keybinds section");

    const rows = findAllByAttr(section, "data-custom-keybinds-row");
    assert.strictEqual(rows.length, 4, "one row per rebindable shortcut (broken entries skipped)");

    const homeRow = rows.find((row) => row.getAttribute("data-custom-keybinds-row") === "Keybind.goToHome");
    assert.ok(homeRow);
    assert.ok(homeRow.textContent.includes("Cmd+H"), "overridden row shows the recorded combo");
    assert.ok(findButton(homeRow, "Edit"), "every row has an Edit button");
    assert.ok(findButton(homeRow, "Reset"), "overridden rows have a Reset button");

    const panelRow = rows.find((row) => row.getAttribute("data-custom-keybinds-row") === "Keybind.toggleSpacePanel");
    assert.ok(findButton(panelRow, "Edit"));
    assert.strictEqual(findButton(panelRow, "Reset"), null, "unmodified rows have no Reset button");
    assert.ok(panelRow.textContent.includes("Shift+Cmd+D"), "unmodified rows show Element's default combo");

    assert.ok(findButton(section, "Reset all to defaults"), "the pane gains a Reset-all control");

    // The Edit button starts the recorder for that row.
    findButton(panelRow, "Edit").click();
    assert.strictEqual(def._test.isRecording(), true);
    const recorder = state.listeners.find((entry) => entry.type === "keydown" && entry.capture === true);
    recorder.listener(keyEvent({ key: "Escape", code: "Escape" }));
    assert.strictEqual(def._test.isRecording(), false);

    def.stop();
    assert.strictEqual(
        findByAttr(state.paneEl, "data-custom-keybinds-section"),
        null,
        "stop() must remove the injected section",
    );
    assert.strictEqual(state.listeners.filter((entry) => entry.type === "keydown").length, 0);
}

// Without the shortcuts table nothing is injected and nothing breaks.
{
    const state = loadPatch({ pane: true });
    const { def } = state.registered;
    def.start();
    def._test.sync();
    assert.strictEqual(findByAttr(state.paneEl, "data-custom-keybinds-section"), null);
    def.stop();
}

console.log("custom-keybinds self-check OK");
