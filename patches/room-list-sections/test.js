// Self-check for the room-list-sections patch's registration and the pure
// low-priority predicate.
// Run: node patches/room-list-sections/test.js
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

let registered = null;
const sandbox = {
    window: {
        mods: {
            registerPatch(id, def) {
                registered = { id, def };
            },
        },
    },
    console,
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

console.log("room-list-sections self-check OK");
