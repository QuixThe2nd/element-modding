"use strict";

/*
 * dm-badges: count DM notification badges toward the space tile their contact
 * belongs to (e.g. bridged WhatsApp DMs badge the WhatsApp space), in addition
 * to People.
 *
 * How: SpaceStore keeps one SpaceNotificationState per space and feeds it the
 * space's rooms via setRooms(). We wrap setRooms() so each space's list also
 * gets the DM rooms whose contact is a member of that space. Once a DM is in a
 * state's room list, Element's own per-room notification listeners keep the
 * badge live, so we only need to recompute when the DM <-> space mapping
 * itself changes (m.direct account data, a space's membership, a new room).
 *
 * Performance notes (accounts with ~1k rooms / ~200 spaces):
 *  - Nothing is armed until the client's first sync has completed; doing work
 *    on every timeline/decryption event during initial sync made startup take
 *    10+ minutes instead of <1.
 *  - The m.direct map, each space's member set and each space's DM list are
 *    cached and only invalidated by the events that can change them.
 *  - Recomputes are debounced; there is no periodic refresh.
 */
(function () {
    const PATCH_ID = "dm-badges";
    const LOG_PREFIX = "[element-mods] " + PATCH_ID;
    const KICK_DEBOUNCE_MS = 1000;
    const WAIT_POLL_MS = 400;
    const WAIT_MAX_ATTEMPTS = 180; // ~72s for SpaceStore/client to appear

    let origGetNotificationState = null;
    const wrapped = [];          // [{state, origSetRooms}]
    const clientHandlers = [];   // [[event, handler]]
    let waitTimer = null;
    let syncHandler = null;
    let armedClient = null;
    let kick = null;             // debounced updateNotificationStates, created in arm()

    // ---- caches -------------------------------------------------------------
    let roomToUser = null;                 // Map<roomId, userId> from m.direct
    const spaceMembers = new Map();        // Map<spaceId, Set<userId>>
    const dmRoomsBySpace = new Map();      // Map<spaceId, Room[]>

    function invalidateAll() {
        roomToUser = null;
        spaceMembers.clear();
        dmRoomsBySpace.clear();
    }

    function invalidateSpace(spaceId) {
        spaceMembers.delete(spaceId);
        dmRoomsBySpace.delete(spaceId);
    }

    function mxMatrixClient() {
        try {
            if (window.mxMatrixClientPeg && typeof window.mxMatrixClientPeg.safeGet === "function") {
                return window.mxMatrixClientPeg.safeGet();
            }
        } catch (e) { /* not logged in yet */ }
        return null;
    }

    function getRoomToUser(client) {
        if (roomToUser) return roomToUser;
        const map = new Map();
        const ev = client.getAccountData("m.direct");
        const content = (ev && ev.getContent()) || {};
        for (const userId of Object.keys(content)) {
            const roomIds = content[userId];
            if (!Array.isArray(roomIds)) continue;
            for (const roomId of roomIds) {
                if (typeof roomId === "string") map.set(roomId, userId);
            }
        }
        roomToUser = map;
        return map;
    }

    function getSpaceMembers(space) {
        let set = spaceMembers.get(space.roomId);
        if (!set) {
            set = new Set(space.getMembers().map(function (m) { return m.userId; }));
            spaceMembers.set(space.roomId, set);
        }
        return set;
    }

    function dmRoomsForSpace(client, spaceKey) {
        const cached = dmRoomsBySpace.get(spaceKey);
        if (cached) return cached;
        let out = [];
        try {
            const space = client.getRoom(spaceKey);
            if (space) {
                const members = getSpaceMembers(space);
                for (const [roomId, userId] of getRoomToUser(client)) {
                    if (!members.has(userId)) continue;
                    const room = client.getRoom(roomId);
                    if (room) out.push(room);
                }
            }
        } catch (e) {
            console.error(LOG_PREFIX, e);
            out = [];
        }
        dmRoomsBySpace.set(spaceKey, out);
        return out;
    }

    function ensureWrapped(state, key) {
        try {
            if (!state || typeof state.setRooms !== "function" || state.__dmBadgesWrapped) return;

            const origSetRooms = state.setRooms.bind(state);
            state.__dmBadgesWrapped = true;
            state.setRooms = function (rooms) {
                let list = rooms;
                try {
                    const client = mxMatrixClient();
                    if (client && typeof key === "string" && key.startsWith("!")) {
                        const dms = dmRoomsForSpace(client, key);
                        if (dms.length) {
                            const have = new Set(list.map(function (r) { return r.roomId; }));
                            const extra = dms.filter(function (r) { return !have.has(r.roomId); });
                            if (extra.length) list = list.concat(extra);
                        }
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
            }, KICK_DEBOUNCE_MS);
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

    function initialSyncDone(client) {
        if (typeof client.isInitialSyncComplete === "function") return client.isInitialSyncComplete();
        const s = typeof client.getSyncState === "function" ? client.getSyncState() : null;
        return s === "PREPARED" || s === "SYNCING";
    }

    function armWhenReady(client) {
        // IMPORTANT: do not touch window.mxSdkContext.spaceStore before the
        // first sync. It is a lazy getter: reading it instantiates SpaceStore
        // early, and a SpaceStore that exists during initial sync rebuilds the
        // whole space hierarchy for every room injected (minutes of startup
        // on accounts with hundreds of spaces).
        const store = getSpaceStore();
        if (store && typeof store.getNotificationState === "function") {
            arm(store, client);
        } else {
            console.log(LOG_PREFIX, "SpaceStore not found or lacks getNotificationState; patch inert");
        }
    }

    function start() {
        // The mods loader runs at page load, before Element logs in — poll for
        // the client only, then wait for its first sync before doing any work.
        let attempts = 0;
        waitTimer = setInterval(function () {
            attempts++;
            const client = mxMatrixClient();
            if (client) {
                clearInterval(waitTimer);
                waitTimer = null;
                if (initialSyncDone(client)) {
                    armWhenReady(client);
                } else {
                    syncHandler = function (state) {
                        if (state !== "PREPARED" && state !== "SYNCING") return;
                        client.off("sync", syncHandler);
                        syncHandler = null;
                        armWhenReady(client);
                    };
                    client.on("sync", syncHandler);
                }
                return;
            }
            if (attempts >= WAIT_MAX_ATTEMPTS) {
                clearInterval(waitTimer);
                waitTimer = null;
                console.log(LOG_PREFIX, "Matrix client not found; patch inert");
            }
        }, WAIT_POLL_MS);
    }

    function listen(client, ev, h) {
        client.on(ev, h);
        clientHandlers.push([ev, h]);
    }

    function arm(store, client) {
        armedClient = client;
        invalidateAll();

        // Wrap getNotificationState so newly created states pass through ensureWrapped.
        origGetNotificationState = store.getNotificationState.bind(store);
        store.getNotificationState = function (key) {
            const state = origGetNotificationState(key);
            ensureWrapped(state, key);
            return state;
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

        kick = makeKick(store);
        try {
            // DM map changed.
            listen(client, "accountData", function (ev) {
                if (ev && ev.getType && ev.getType() === "m.direct") {
                    invalidateAll();
                    kick();
                }
            });
            // Someone joined/left a space: only that space's DM list changes.
            listen(client, "RoomState.members", function (ev, roomState) {
                const roomId = roomState && roomState.roomId;
                if (!roomId) return;
                const room = client.getRoom(roomId);
                if (!room || !room.isSpaceRoom()) return;
                invalidateSpace(roomId);
                kick();
            });
            // A DM room we didn't know about yet (e.g. new bridged chat).
            listen(client, "Room", function (room) {
                if (room && getRoomToUser(client).has(room.roomId)) {
                    dmRoomsBySpace.clear();
                    kick();
                }
            });
        } catch (e) {
            console.error(LOG_PREFIX, e);
        }

        // One initial recompute so existing states pick up their DMs.
        try {
            store.updateNotificationStates();
        } catch (e) {
            console.error(LOG_PREFIX, e);
        }
        console.log(LOG_PREFIX, "started");
    }

    function stop() {
        if (waitTimer !== null) {
            clearInterval(waitTimer);
            waitTimer = null;
        }

        const client = armedClient || mxMatrixClient();
        if (client && typeof client.off === "function") {
            if (syncHandler) {
                try { client.off("sync", syncHandler); } catch (e) { /* ignore */ }
            }
            clientHandlers.forEach(function (pair) {
                try { client.off(pair[0], pair[1]); } catch (e) { /* ignore */ }
            });
        }
        syncHandler = null;
        clientHandlers.length = 0;
        armedClient = null;

        if (kick) {
            kick.cancel();
            kick = null;
        }

        wrapped.forEach(function (entry) {
            try {
                entry.state.setRooms = entry.origSetRooms;
                delete entry.state.__dmBadgesWrapped;
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

        invalidateAll();

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
