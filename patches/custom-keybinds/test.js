// Self-check for the custom keybinds patch's pure logic and key handling.
// Run: node patches/custom-keybinds/test.js
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const STORAGE_KEY = "element-mods.custom-keybinds";
const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

function storageWith(value) {
    return {
        getItem(key) {
            assert.strictEqual(key, STORAGE_KEY);
            return value;
        },
    };
}

function loadPatch({ stored = null, dialog = false, dispatcher } = {}) {
    let registered = null;
    const listeners = [];
    const window = {
        mods: {
            registerPatch(id, def) {
                registered = { id, def };
            },
        },
        localStorage: storageWith(stored),
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
    if (dispatcher !== undefined) window.mxDispatcher = dispatcher;
    const document = {
        querySelector(selector) {
            return selector === ".mx_Dialog_wrapper" && dialog ? { dialog: true } : null;
        },
    };
    const sandbox = { window, document, console };
    window.window = window;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    function keydownListener() {
        const matches = listeners.filter((entry) => entry.type === "keydown" && entry.capture === true);
        assert.strictEqual(matches.length, 1, "start should add exactly one capture keydown listener");
        return matches[0].listener;
    }

    return { registered, listeners, keydownListener };
}

function makeDispatcher() {
    const dispatches = [];
    const fires = [];
    return {
        dispatches,
        fires,
        dispatch(payload) {
            dispatches.push(payload);
        },
        fire(action) {
            fires.push(action);
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

// --- registration ---
{
    const { registered } = loadPatch();
    assert.ok(registered, "patch should register");
    assert.strictEqual(registered.id, "custom-keybinds");
    assert.strictEqual(typeof registered.def.start, "function");
    assert.strictEqual(typeof registered.def.stop, "function");
}

const t = loadPatch().registered.def._test;
assert.ok(t, "patch should expose _test helpers");

// --- comboFromEvent ---
assert.strictEqual(t.comboFromEvent({ metaKey: true, code: "KeyH", key: "h" }), "Cmd+H");
assert.strictEqual(t.comboFromEvent({ ctrlKey: true, shiftKey: true, code: "KeyH", key: "h" }), "Ctrl+Shift+H");
assert.strictEqual(t.comboFromEvent({ altKey: true, metaKey: true, code: "KeyH", key: "˙" }), "Alt+Cmd+H");
assert.strictEqual(t.comboFromEvent({ metaKey: true, code: "MetaLeft", key: "Meta" }), null);
assert.strictEqual(t.comboFromEvent({ code: "KeyH", key: "h" }), null, "plain typing is not bindable");
assert.strictEqual(t.comboFromEvent({ code: "F5", key: "F5" }), "F5");
assert.strictEqual(t.comboFromEvent({ ctrlKey: true, code: "Comma", key: "," }), "Ctrl+Comma");

// --- loadBindings ---
assert.deepEqual(t.loadBindings(storageWith(null)), [{ combo: "Cmd+H", action: "go_home" }]);
assert.deepEqual(t.loadBindings(storageWith("{not json")), [{ combo: "Cmd+H", action: "go_home" }]);
assert.deepEqual(t.loadBindings(storageWith(JSON.stringify({ bindings: [] }))), []);
assert.deepEqual(t.loadBindings(storageWith(JSON.stringify({ bindings: "nope" }))), [
    { combo: "Cmd+H", action: "go_home" },
]);
assert.deepEqual(
    t.loadBindings(
        storageWith(
            JSON.stringify({
                bindings: [
                    { combo: "Cmd+H", action: "unknown_action" },
                    { combo: "Shift+H", action: "go_home" },
                    { combo: "Ctrl+Shift+S", action: "toggle_space_panel" },
                ],
            }),
        ),
    ),
    [{ combo: "Ctrl+Shift+S", action: "toggle_space_panel" }],
);

// --- key handler ---
function press(state, props) {
    const event = keyEvent(props);
    state.keydownListener()(event);
    return event;
}

{
    const dispatcher = makeDispatcher();
    const state = loadPatch({ dispatcher });
    state.registered.def.start();
    const event = press(state, { metaKey: true, code: "KeyH", key: "h" });
    assert.deepEqual(dispatcher.dispatches, [{ action: "view_home_page" }]);
    assert.deepEqual(dispatcher.fires, []);
    assert.strictEqual(event.prevented, true);
    assert.strictEqual(event.stopped, true);
    state.registered.def.stop();
}

{
    const dispatcher = makeDispatcher();
    const state = loadPatch({ dispatcher, dialog: true });
    state.registered.def.start();
    const event = press(state, { metaKey: true, code: "KeyH", key: "h" });
    assert.deepEqual(dispatcher.dispatches, [], "dialog guard should skip dispatch");
    assert.strictEqual(event.prevented, true, "dialog guard should still consume the key");
    assert.strictEqual(event.stopped, true);
    state.registered.def.stop();
}

{
    const dispatcher = makeDispatcher();
    const state = loadPatch({ dispatcher });
    state.registered.def.start();
    const event = press(state, { metaKey: true, shiftKey: true, code: "KeyH", key: "H" });
    assert.deepEqual(dispatcher.dispatches, []);
    assert.strictEqual(event.prevented, false);
    assert.strictEqual(event.stopped, false);
    state.registered.def.stop();
}

{
    const dispatcher = makeDispatcher();
    const state = loadPatch({ dispatcher });
    state.registered.def.start();
    const event = press(state, { repeat: true, metaKey: true, code: "KeyH", key: "h" });
    assert.deepEqual(dispatcher.dispatches, []);
    assert.strictEqual(event.prevented, false);
    assert.strictEqual(event.stopped, false);
    state.registered.def.stop();
}

{
    const state = loadPatch();
    state.registered.def.start();
    const event = press(state, { metaKey: true, code: "KeyH", key: "h" });
    assert.strictEqual(event.prevented, false, "missing dispatcher must let Cmd+H fall through");
    assert.strictEqual(event.stopped, false);
    state.registered.def.stop();
}

{
    const dispatcher = makeDispatcher();
    const state = loadPatch({ dispatcher });
    state.registered.def._test.setRecording(true);
    state.registered.def.start();
    const event = press(state, { metaKey: true, code: "KeyH", key: "h" });
    assert.deepEqual(dispatcher.dispatches, []);
    assert.strictEqual(event.prevented, false);
    assert.strictEqual(event.stopped, false);
    state.registered.def.stop();
}

{
    const dispatcher = makeDispatcher();
    const state = loadPatch({
        dispatcher,
        stored: JSON.stringify({ bindings: [{ combo: "Ctrl+Shift+S", action: "toggle_space_panel" }] }),
    });
    state.registered.def.start();
    const event = press(state, { ctrlKey: true, shiftKey: true, code: "KeyS", key: "s" });
    assert.deepEqual(dispatcher.fires, ["toggle_space_panel"]);
    assert.deepEqual(dispatcher.dispatches, []);
    assert.strictEqual(event.prevented, true);
    assert.strictEqual(event.stopped, true);
    state.registered.def.stop();
}

{
    const dispatcher = makeDispatcher();
    const state = loadPatch({
        dispatcher,
        stored: JSON.stringify({ bindings: [{ combo: "Alt+Cmd+Comma", action: "open_settings" }] }),
    });
    state.registered.def.start();
    press(state, { altKey: true, metaKey: true, code: "Comma", key: "," });
    assert.deepEqual(dispatcher.dispatches, [{ action: "view_user_settings" }]);
    state.registered.def.stop();
}

// --- lifecycle ---
{
    const state = loadPatch({ dispatcher: makeDispatcher() });
    state.registered.def.start();
    assert.strictEqual(
        state.listeners.filter((entry) => entry.type === "keydown" && entry.capture === true).length,
        1,
    );
    state.registered.def.stop();
    assert.strictEqual(
        state.listeners.filter((entry) => entry.type === "keydown" && entry.capture === true).length,
        0,
        "stop should remove the keydown listener",
    );
}

console.log("custom-keybinds self-check OK");
