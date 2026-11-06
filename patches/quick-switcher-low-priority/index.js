/*
Patch: Quick switcher low priority.

In Element's Spotlight dialog (the Cmd+K quick switcher), rooms tagged
"m.lowpriority" would otherwise appear interleaved with normal results.
This patch collapses them to the bottom of the dialog behind a
"Show low priority" button.

How it works:
  - A 250ms timer scans while the dialog is open (bails immediately when
    .mx_SpotlightDialog is absent, so a closed dialog costs one
    querySelector per tick).
  - Only "results" sections (.mx_SpotlightDialog_section.mx_SpotlightDialog_results)
    are processed; "recently viewed"/"recent searches" sections are left
    alone. Within them, each role=option node is mapped to a room id via
    its DOM id (mx_SpotlightDialog_button_result_<roomId>, sliced — never
    split — because room ids contain "_" and ":"), falling back to the
    React fiber walk used by the room-list-sections patch.
  - Low-priority options are hidden with display:none only: Element's own
    roving-tabindex navigation skips nodes with offsetParent === null, so
    arrow-key order and Enter keep working, and React keeps owning the DOM.
  - One toggle row is injected after the first marked section's option
    list, labelled "Show low priority (N)" / "Hide low priority (N)";
    the expanded/collapsed state is persisted in localStorage
    ("element-mods.quick-switcher-low-priority", default collapsed).
  - Zero footprint: the style element exists only while the dialog is open
    AND at least one option is marked, and stop() removes everything.
*/
(() => {
    "use strict";

    const PATCH_ID = "quick-switcher-low-priority";
    const STORAGE_KEY = "element-mods.quick-switcher-low-priority";
    const STYLE_ID = "element-mods-qs-lp-style";

    const DIALOG_SELECTOR = ".mx_SpotlightDialog";
    const RESULTS_SECTION_SELECTOR = ".mx_SpotlightDialog_section.mx_SpotlightDialog_results";
    const OPTION_SELECTOR = '[role="option"]';
    const RESULT_ID_PREFIX = "mx_SpotlightDialog_button_result_";
    const HIDDEN_ATTR = "data-element-mods-lp-hidden";
    const SECTION_ATTR = "data-element-mods-lp-section";
    const TOGGLE_CLASS = "mx_elementModsLpToggle";
    const REFRESH_INTERVAL = 250;

    let refreshTimer = null;

    // -- pure helpers (exported via _test) ---------------------------------

    function isLowPriorityRoom(room) {
        if (!room || typeof room !== "object") return false;
        const tags = room.tags;
        if (!tags || typeof tags !== "object") return false;
        return Object.prototype.hasOwnProperty.call(tags, "m.lowpriority");
    }

    // Room ids contain ":" and "_", so slice after the literal prefix —
    // never split on "_". Returns null for unrelated ids (e.g. the
    // "no results" button) or empty room ids.
    function roomIdFromOptionId(id) {
        if (typeof id !== "string" || !id.startsWith(RESULT_ID_PREFIX)) return null;
        const roomId = id.slice(RESULT_ID_PREFIX.length);
        return roomId || null;
    }

    // Split option ids into {normal, low}, preserving input order in both.
    function partitionOptionIds(ids, lowPrioRoomIds) {
        const set = lowPrioRoomIds instanceof Set ? lowPrioRoomIds : new Set(lowPrioRoomIds || []);
        const normal = [];
        const low = [];
        for (const id of ids || []) {
            const roomId = roomIdFromOptionId(id);
            if (roomId && set.has(roomId)) low.push(id);
            else normal.push(id);
        }
        return { normal, low };
    }

    // Decide where the single toggle row goes: on the first section (in
    // input/DOM order) that has at least one low-priority result.
    function planSections(sections, expanded) {
        let toggleOnSectionId = null;
        for (const section of sections || []) {
            if (section.lowCount > 0) {
                toggleOnSectionId = section.id;
                break;
            }
        }
        return { collapsed: !expanded, toggleOnSectionId };
    }

    // -- client access ------------------------------------------------------

    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        try {
            if (typeof peg.safeGet === "function") return peg.safeGet();
            if (typeof peg.get === "function") return peg.get();
        } catch (_) {
            /* ignore */
        }
        return null;
    }

    function lowPriorityRoomIds() {
        const set = new Set();
        const client = getClient();
        let rooms = [];
        try {
            rooms = (client && client.getRooms()) || [];
        } catch (_) {
            /* ignore */
        }
        for (const room of rooms) {
            if (isLowPriorityRoom(room) && typeof room.roomId === "string") set.add(room.roomId);
        }
        return set;
    }

    // -- room id resolution per option node ---------------------------------
    // Same production fiber walk as the room-list-sections patch: read
    // memoizedProps upward (guard ~80 hops) looking for a room id.

    function roomIdFromProps(props) {
        if (!props || typeof props !== "object") return null;
        if (typeof props.roomId === "string" && props.roomId) return props.roomId;
        if (props.room && typeof props.room.roomId === "string") return props.room.roomId;
        for (const key of ["viewModel", "vm"]) {
            const vm = props[key];
            if (vm && typeof vm === "object") {
                if (typeof vm.roomId === "string" && vm.roomId) return vm.roomId;
                if (vm.props && vm.props.room && typeof vm.props.room.roomId === "string") return vm.props.room.roomId;
                if (vm.item && typeof vm.item.roomId === "string") return vm.item.roomId;
            }
        }
        if (props.item && typeof props.item.roomId === "string") return props.item.roomId;
        return null;
    }

    function findRoomIdFromNode(node) {
        let fiber = null;
        for (const key in node) {
            if (key.startsWith("__reactFiber$")) {
                fiber = node[key];
                break;
            }
        }
        let guard = 0;
        while (fiber && guard++ < 80) {
            const id = roomIdFromProps(fiber.memoizedProps);
            if (id) return id;
            fiber = fiber.return;
        }
        return null;
    }

    function roomIdFromOptionNode(node) {
        const id = node.id;
        if (typeof id === "string") {
            const roomId = roomIdFromOptionId(id);
            if (roomId) return roomId;
        }
        return findRoomIdFromNode(node);
    }

    // -- expanded/collapsed state -------------------------------------------

    function readExpanded() {
        try {
            const raw = window.localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object" && typeof parsed.expanded === "boolean") {
                    return parsed.expanded;
                }
            }
        } catch (_) {
            /* ignore */
        }
        return false; // default: collapsed
    }

    function writeExpanded(value) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ expanded: value }));
        } catch (_) {
            /* ignore */
        }
    }

    // -- style / toggle row --------------------------------------------------

    function styleText() {
        const hidden = `[${HIDDEN_ATTR}="1"]`;
        return (
            `body:not(.elementModsQsLpExpanded) ${hidden} { display: none !important; }` +
            `.mx_elementModsLpToggle { width: 100%; box-sizing: border-box; padding: 8px 12px; border-top: 1px solid var(--cpd-color-border-subtle, rgba(0,0,0,.08)); }` +
            `.mx_elementModsLpToggle button { width: 100%; padding: 6px 12px; border: none; border-radius: 8px; background: transparent; color: var(--cpd-color-text-secondary, inherit); font-size: 13px; cursor: pointer; text-align: center; }` +
            `.mx_elementModsLpToggle button:hover { background: var(--cpd-color-bg-subtle-primary, rgba(0,0,0,.05)); }`
        );
    }

    function injectStyle() {
        let style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement("style");
            style.id = STYLE_ID;
            document.head.appendChild(style);
        }
        style.textContent = styleText();
        document.body.classList.toggle("elementModsQsLpExpanded", readExpanded());
    }

    function removeStyle() {
        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();
        document.body.classList.remove("elementModsQsLpExpanded");
    }

    function setToggleLabel(button, count) {
        button.textContent = (readExpanded() ? "Hide low priority" : "Show low priority") + " (" + count + ")";
    }

    function createToggleRow(count) {
        const row = document.createElement("div");
        row.className = TOGGLE_CLASS;
        row.setAttribute(SECTION_ATTR + "-toggle", "1");
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1; // stay out of roving tabindex; mouse only
        setToggleLabel(button, count);
        button.addEventListener("click", () => {
            writeExpanded(!readExpanded());
            apply();
        });
        row.appendChild(button);
        return row;
    }

    function removeToggleRow(section) {
        const row = section.querySelector(":scope > ." + TOGGLE_CLASS);
        if (row) row.remove();
    }

    // -- main pass -----------------------------------------------------------

    function apply() {
        if (!document.querySelector(DIALOG_SELECTOR)) {
            // Dialog closed: zero DOM footprint (the dialog's subtree dies on
            // its own); just drop our style element if it lingers.
            removeStyle();
            return;
        }

        const lowIds = lowPriorityRoomIds();
        const markedSections = [];
        let markedCount = 0;

        for (const section of document.querySelectorAll(RESULTS_SECTION_SELECTOR)) {
            let options;
            try {
                options = Array.from(section.querySelectorAll(OPTION_SELECTOR));
            } catch (_) {
                continue;
            }
            let sectionLow = 0;
            for (const option of options) {
                let isLow = false;
                const roomId = roomIdFromOptionNode(option);
                if (roomId) isLow = lowIds.has(roomId);
                if (isLow) {
                    option.setAttribute(HIDDEN_ATTR, "1");
                    sectionLow++;
                } else {
                    option.removeAttribute(HIDDEN_ATTR);
                }
            }
            if (sectionLow > 0) {
                section.setAttribute(SECTION_ATTR, "1");
                markedSections.push({ section, lowCount: sectionLow });
                markedCount += sectionLow;
            } else {
                section.removeAttribute(SECTION_ATTR);
                removeToggleRow(section);
            }
        }

        if (markedCount === 0) {
            // Nothing low-priority among the results: zero footprint.
            removeStyle();
            return;
        }

        injectStyle();

        // Exactly one toggle row, on the first marked section in DOM order.
        const first = markedSections[0];
        for (const { section } of markedSections.slice(1)) removeToggleRow(section);
        for (const section of document.querySelectorAll(`[${SECTION_ATTR}]`)) {
            if (!markedSections.some((m) => m.section === section)) removeToggleRow(section);
        }
        let row = first.section.querySelector(":scope > ." + TOGGLE_CLASS);
        if (!row) {
            row = createToggleRow(markedCount);
            first.section.appendChild(row); // after the inner options div
        } else {
            setToggleLabel(row.querySelector("button"), markedCount);
        }
    }

    // -- lifecycle -----------------------------------------------------------

    function start() {
        if (refreshTimer) return;
        refreshTimer = setInterval(apply, REFRESH_INTERVAL);
        apply();
    }

    function stop() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        removeStyle();
        for (const section of document.querySelectorAll(`[${SECTION_ATTR}]`)) {
            section.removeAttribute(SECTION_ATTR);
            removeToggleRow(section);
        }
        for (const option of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
            option.removeAttribute(HIDDEN_ATTR);
        }
    }

    window.mods.registerPatch(PATCH_ID, {
        start,
        stop,
        _test: {
            isLowPriorityRoom,
            roomIdFromOptionId,
            partitionOptionIds,
            planSections,
        },
    });
})();
