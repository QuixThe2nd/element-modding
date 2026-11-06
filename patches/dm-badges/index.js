"use strict";

(function () {
    const PATCH_ID = "dm-badges";
    const LOG_PREFIX = "[element-mods] " + PATCH_ID;

    let origGetNotificationState = null;
    const wrapped = [];          // [{state, origSetRooms}]
    const clientHandlers = [];   // [[event, handler]]
    let kickTimer = null;
    let intervalId = null;
    let waitTimer = null;

    function mxMatrixClient() {
        try {
            if (window.mxMatrixClientPeg && typeof window.mxMatrixClientPeg.safeGet === "function") {
                return window.mxMatrixClientPeg.safeGet();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function dmRoomsForSpace(client, spaceKey) {
        try {
            // Build the DM map fresh on every call: account data may have changed.
            const content = (client.getAccountData("m.direct") && client.getAccountData("m.direct").getContent()) || {};
            const roomToUser = {};
            Object.keys(content).forEach(function (userId) {
                const roomIds = content[userId];
                if (!Array.isArray(roomIds)) return;
                roomIds.forEach(function (roomId) {
                    if (typeof roomId === "string") roomToUser[roomId] = userId;
                });
            });

            const space = client.getRoom(spaceKey);
            if (!space) return [];
            let members = null;
            try {
                members = new Set(space.getMembers().map(function (m) { return m.userId; }));
            } catch (e) {
                console.error(LOG_PREFIX, e);
                return [];
            }

            const out = [];
            const rooms = client.getRooms();
            for (let i = 0; i < rooms.length; i++) {
                const room = rooms[i];
                const userId = roomToUser[room.roomId];
                if (!userId || !members.has(userId)) continue;
                out.push(room);
            }
            return out;
        } catch (e) {
            console.error(LOG_PREFIX, e);
            return [];
        }
    }

    function ensureWrapped(state, key) {
        try {
            if (!state) return;
            if (typeof state.setRooms !== "function") return;
            if (state.__waDmWrapped) return;

            const origSetRooms = state.setRooms.bind(state);
            state.__waDmWrapped = true;
            state.setRooms = function (rooms) {
                let list = rooms;
                try {
                    const client = mxMatrixClient();
                    if (client && typeof key === "string" && key.startsWith("!")) {
                        const extra = dmRoomsForSpace(client, key).filter(function (r) {
                            return !list.includes(r);
                        });
                        if (extra.length) list = list.concat(extra);
                    }
                } catch (e) {
                    console.error(LOG_PREFIX, e);
                }
                return origSetRooms(list);
            };
            wrapped.push({ state: state, origSetRooms: origSetRooms });
        } catch (e) {
            console.error(LOG_PREFIX, e);
        }
    }

    let kick = null; // debounced updateNotificationStates, created in start()

    function makeKick(store) {
        let timer = null;
        const fn = function () {
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () {
                timer = null;
                try {
                    store.updateNotificationStates();
                } catch (e) {
                    console.error(LOG_PREFIX, e);
                }
            }, 300);
        };
        fn.cancel = function () {
            if (timer) clearTimeout(timer);
            timer = null;
        };
        return fn;
    }

    function getSpaceStore() {
        // Element 1.12.x exposes the SpaceStore via mxSdkContext; older builds
        // exposed it as mxSpaceStore directly. Prefer whichever exists.
        if (window.mxSdkContext && window.mxSdkContext.spaceStore) return window.mxSdkContext.spaceStore;
        return window.mxSpaceStore || null;
    }

    function start() {
        // The mods loader runs at page load, before Element sets
        // window.mxSdkContext — poll until the SpaceStore shows up.
        let attempts = 0;
        waitTimer = setInterval(function () {
            attempts++;
            const store = getSpaceStore();
            if (store && typeof store.getNotificationState === "function") {
                clearInterval(waitTimer);
                waitTimer = null;
                arm(store);
                return;
            }
            if (attempts >= 180) {
                clearInterval(waitTimer);
                waitTimer = null;
                console.log(LOG_PREFIX, "SpaceStore not found or lacks getNotificationState; patch inert");
            }
        }, 400);
    }

    function arm(store) {
        // Wrap getNotificationState so newly created states pass through ensureWrapped.
        origGetNotificationState = store.getNotificationState.bind(store);
        store.getNotificationState = function (key) {
            const state = origGetNotificationState(key);
            return ensureWrappedState(state, key);
        };

        // Wrap states that already exist.
        try {
            if (store.notificationStateMap instanceof Map) {
                store.notificationStateMap.forEach(function (state, key) {
                    ensureWrapped(state, key);
                });
            }
        } catch (e) {
            console.error(LOG_PREFIX, e);
        }

        // Live updates: listen to sync-ish events and periodically recompute.
        kick = makeKick(store);
        try {
            const client = (window.mxMatrixClientPeg && typeof window.mxMatrixClientPeg.safeGet === "function")
                ? window.mxMatrixClientPeg.safeGet() : null;
            if (client && typeof client.on === "function") {
                ["Room.receipt", "Room.timeline", "Event.decrypted", "AccountData"].forEach(function (ev) {
                    try {
                        const h = function () { kick(); };
                        client.on(ev, h);
                        clientHandlers.push([ev, h]);
                    } catch (e) {
                        console.error(LOG_PREFIX, e);
                    }
                });
            }
        } catch (e) {
            console.error(LOG_PREFIX, e);
        }
        try {
            intervalId = setInterval(function () { kick(); }, 15000);
        } catch (e) {
            console.error(LOG_PREFIX, e);
        }

        kick();
        console.log(LOG_PREFIX, "started");
    }

    function ensureWrappedState(state, key) {
        ensureWrapped(state, key);
        return state;
    }

    function stop() {
        if (waitTimer !== null) {
            clearInterval(waitTimer);
            waitTimer = null;
        }

        try {
            const client = (window.mxMatrixClientPeg && typeof window.mxMatrixClientPeg.safeGet === "function")
                ? window.mxMatrixClientPeg.safeGet() : null;
            if (client && typeof client.off === "function") {
                clientHandlers.forEach(function (pair) {
                    try {
                        client.off(pair[0], pair[1]);
                    } catch (e) { /* ignore */ }
                });
            }
        } catch (e) { /* ignore */ }
        clientHandlers.length = 0;

        if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
        }
        if (kick) {
            kick.cancel();
            kick = null;
        }

        wrapped.forEach(function (entry) {
            try {
                entry.state.setRooms = entry.origSetRooms;
                delete entry.state.__waDmWrapped;
            } catch (e) {
                console.error(LOG_PREFIX, e);
            }
        });
        wrapped.length = 0;

        const store = getSpaceStore();
        if (store && origGetNotificationState) {
            try {
                store.getNotificationState = origGetNotificationState;
            } catch (e) {
                console.error(LOG_PREFIX, e);
            }
            origGetNotificationState = null;
        }

        if (store) {
            try {
                store.updateNotificationStates();
            } catch (e) { /* ignore */ }
        }
        console.log(LOG_PREFIX, "stopped");
    }

    if (window.mods && typeof window.mods.registerPatch === "function") {
        window.mods.registerPatch(PATCH_ID, { start: start, stop: stop });
    } else {
        console.error(LOG_PREFIX, "window.mods.registerPatch not available; patch not registered");
    }
})();
