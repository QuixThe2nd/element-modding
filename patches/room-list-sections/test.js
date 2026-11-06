// Self-check for the room-list-sections patch's registration and the pure
// low-priority predicate.
// Run: node patches/room-list-sections/test.js
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

let registered = null;

// -- minimal browser mocks ------------------------------------------------
const rafQueue = [];
function requestAnimationFrame(cb) {
    rafQueue.push(cb);
    return rafQueue.length;
}
function cancelAnimationFrame() {
    /* not needed by the patch's logic under test */
}
function flushRaf() {
    const cbs = rafQueue.splice(0, rafQueue.length);
    for (const cb of cbs) cb();
}

const storage = new Map();
const listeners = {};
const fakeClient = {
    on(event, fn) {
        (listeners[event] ||= []).push(fn);
    },
    off(event, fn) {
        listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
    getRooms: () => [],
};

const sandbox = {
    console,
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
    document: {
        querySelectorAll: () => [],
        querySelector: () => null,
        getElementById: () => null,
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
        head: { appendChild() {} },
        body: {},
    },
    MutationObserver: class {
        observe() {}
        disconnect() {}
    },
    window: {
        mods: {
            registerPatch(id, def) {
                registered = { id, def };
            },
        },
        localStorage: {
            getItem: (k) => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, v),
            removeItem: (k) => storage.delete(k),
        },
        mxMatrixClientPeg: { safeGet: () => fakeClient },
        mxSettingsStore: undefined,
    },
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

assert.ok(registered, "patch should register");
assert.strictEqual(registered.id, "room-list-sections");
assert.strictEqual(typeof registered.def.start, "function");
assert.strictEqual(typeof registered.def.stop, "function");

assert.ok(registered.def._test, "patch should expose a _test object");
const { isLowPriorityRoom } = registered.def._test;
assert.strictEqual(typeof isLowPriorityRoom, "function", "_test.isLowPriorityRoom");

assert.strictEqual(isLowPriorityRoom({ roomId: "x", tags: { "m.lowpriority": {} } }), true);
assert.strictEqual(isLowPriorityRoom({ roomId: "x", tags: {} }), false);
assert.strictEqual(isLowPriorityRoom({ roomId: "x", tags: { "m.favourite": {} } }), false);
assert.strictEqual(isLowPriorityRoom({ roomId: "x" }), false, "tags undefined");
assert.strictEqual(isLowPriorityRoom({ roomId: "x", tags: null }), false, "tags null");
assert.strictEqual(isLowPriorityRoom(null), false, "room null");
assert.strictEqual(isLowPriorityRoom(undefined), false, "room undefined");

// -- low-priority hide flash timing ---------------------------------------
const t = registered.def._test;
assert.strictEqual(typeof t.scheduleTileScan, "function", "_test.scheduleTileScan");
assert.strictEqual(typeof t.onSectionToggle, "function", "_test.onSectionToggle");
assert.strictEqual(typeof t.attachClientTagListener, "function", "_test.attachClientTagListener");
assert.strictEqual(typeof t.getScanCount, "function", "_test.getScanCount");

// The tile scan must run pre-paint via requestAnimationFrame coalescing:
// many scheduleTileScan() calls within one frame collapse into ONE rAF
// callback that runs scanTiles once, before the browser paints (a plain
// setTimeout(…, 200) lets the tile flash visible for two frames first).
t.resetScanCount();
assert.strictEqual(rafQueue.length, 0, "no rAF pending before scheduling");
t.scheduleTileScan();
t.scheduleTileScan();
t.scheduleTileScan();
assert.strictEqual(rafQueue.length, 1, "3 schedules coalesce into 1 rAF callback");
assert.strictEqual(t.getScanCount(), 0, "scan not run synchronously by scheduler");
flushRaf();
assert.strictEqual(t.getScanCount(), 1, "exactly one scan per frame");
assert.strictEqual(rafQueue.length, 0, "rAF queue drained");

// The settings toggle must scan synchronously: the switch click already
// happens inside a user-event task, and deferring the scan by even one
// frame lets the freshly-unhidden tiles paint collapsed-then-restored.
t.resetScanCount();
storage.set(
    "element-mods.room-list-sections",
    JSON.stringify({ low_priority: false }),
);
t.onSectionToggle("low_priority", false);
assert.strictEqual(t.getScanCount(), 1, "toggle scans synchronously (no rAF/setTimeout)");

// A Room.tags account-data event (tagging/untagging a room as low priority
// from another device or the room's context menu) must trigger a rescan.
t.resetScanCount();
t.attachClientTagListener();
assert.ok(
    (listeners["Room.tags"] || []).length >= 1,
    "Room.tags listener registered on the client",
);
t.resetScanCount();
for (const fn of listeners["Room.tags"] || []) fn();
assert.strictEqual(rafQueue.length, 1, "Room.tags event schedules a (coalesced) pre-paint scan");
flushRaf();
assert.strictEqual(t.getScanCount(), 1, "Room.tags scan ran exactly once");

console.log("room-list-sections self-check OK");
