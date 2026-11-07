/*
Patch: adds a search box to the top of the Settings dialog.

The Settings dialog (new Element Web / Compound UI) is React-owned: a
.mx_UserSettingsDialog with a .mx_SettingsDialog_content wrapper holding the
tab labels and the active .mx_TabbedView_tabPanel. Instead of registering a
whole tab (window.mods.settingsTabs), this patch injects a small search UI as
the first child of the ACTIVE tab panel (not the content wrapper: that
wrapper has computed height 0 with its .mx_TabbedView absolutely positioned
inside it, so a static child there would overlap the tab rail) and, as the
user types, hides every .mx_SettingsSubsection in the ACTIVE tab panel whose
text does not match the query, plus any .mx_SettingsSection left with zero
visible subsections.

Honest limits: only the currently mounted tab is searched (React keeps the
other tabs' content unmounted). When a query matches nothing, the status line
says so and suggests switching tabs.
*/
(() => {
    "use strict";

    const PATCH_ID = "settings-search";
    const DIALOG_SELECTOR = ".mx_UserSettingsDialog";
    const PANEL_SELECTOR = ".mx_TabbedView_tabPanel:not([data-mods-panel])";
    const SUBSECTION_SELECTOR = ".mx_SettingsSubsection";
    const SECTION_SELECTOR = ".mx_SettingsSection";
    const DEBOUNCE_MS = 100;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // ------------------------------------------------------------------
    // Pure logic (exported through _test for node self-checks)
    // ------------------------------------------------------------------

    // Case-insensitive substring match. An empty or whitespace-only query
    // matches everything (i.e. no filtering).
    function matchesQuery(text, query) {
        const q = typeof query === "string" ? query.trim().toLowerCase() : "";
        if (q === "") return true;
        return String(text || "").toLowerCase().includes(q);
    }

    function hasForeignMutation(records, root) {
        if (!Array.isArray(records) || records.length === 0) return false;
        if (root == null) return true;
        return records.some((record) => record.target !== root && !root.contains(record.target));
    }

    function rightInsetFor(paddingRight) {
        if (paddingRight !== "0px" && /^\d+(\.\d+)?px$/.test(paddingRight)) return paddingRight;
        return "100px";
    }

    // Decides which subsections to hide for a query. subsectionTexts is
    // [{ el, text }]; returns { hide: [el refs], visibleCount } so the DOM
    // layer only applies what this pure function decided.
    function filterPlan({ subsectionTexts, query }) {
        const items = Array.isArray(subsectionTexts) ? subsectionTexts : [];
        const hide = [];
        let visibleCount = 0;
        for (const item of items) {
            if (matchesQuery(item.text, query)) {
                visibleCount++;
            } else {
                hide.push(item.el);
            }
        }
        return { hide, visibleCount };
    }

    // sections is [{ el, subsections: [refs] }] — returns the section els
    // whose subsections all ended up hidden.
    function sectionsToHide(sections) {
        const out = [];
        for (const section of Array.isArray(sections) ? sections : []) {
            const subs = Array.isArray(section.subsections) ? section.subsections : [];
            if (subs.length > 0 && subs.every((s) => s.__settingsSearchHidden)) out.push(section.el);
        }
        return out;
    }

    // Tracks every element the patch set display:none on, so restoring only
    // clears inline styles we added ourselves and never clobbers React's.
    function createRestoreSet() {
        const touched = new Set();
        return {
            has: (node) => touched.has(node),
            size: () => touched.size,
            add(node) {
                node.style.display = "none";
                node.__settingsSearchHidden = true;
                touched.add(node);
            },
            clear() {
                for (const node of touched) {
                    node.style.display = "";
                    node.__settingsSearchHidden = false;
                }
                touched.clear();
            },
        };
    }

    // Debounce factory. `timers` is injectable ({ setTimeout, clearTimeout })
    // so tests can run it with short real delays; the DOM layer uses the
    // global timers. Every new call cancels the pending one, so rapid typing
    // never applies a stale filter.
    function createDebounce(fn, delay, timers) {
        const t = timers || { setTimeout, clearTimeout };
        let handle = null;
        function run(...args) {
            if (handle !== null) t.clearTimeout(handle);
            handle = t.setTimeout(() => {
                handle = null;
                fn(...args);
            }, delay);
        }
        run.cancel = () => {
            if (handle !== null) t.clearTimeout(handle);
            handle = null;
        };
        return run;
    }

    function createFrameScheduler(fn, raf, caf) {
        const requestFrame = raf || window.requestAnimationFrame.bind(window);
        const cancelFrame = caf || window.cancelAnimationFrame.bind(window);
        let handle = null;
        function schedule() {
            if (handle === null) {
                handle = requestFrame(() => {
                    handle = null;
                    fn();
                });
            }
        }
        schedule.cancel = () => {
            if (handle !== null) cancelFrame(handle);
            handle = null;
        };
        return schedule;
    }

    // Picks the visible panel from [{ display, el }]: the first entry whose
    // display is not "none" wins (the modding-tab coordinator hides the
    // React panel via inline style when a custom tab is active); null when
    // nothing is visible.
    function activePanelOf(panels) {
        for (const panel of Array.isArray(panels) ? panels : []) {
            if (panel.display !== "none") return panel.el;
        }
        return null;
    }

    // ------------------------------------------------------------------
    // DOM layer
    // ------------------------------------------------------------------

    let started = false;
    let observer = null;
    let ui = null; // { root, input, clearBtn, status }
    let query = ""; // single source of truth, survives tab switches and dialog close
    const restore = createRestoreSet();
    let applyFilter = null; // debounced, created in start()
    let scheduleApply = null; // animation-frame-coalesced, created in start()

    function buildStatusLine(query, plan) {
        let text = `${plan.visibleCount} result${plan.visibleCount === 1 ? "" : "s"} for '${query}'`;
        if (plan.visibleCount === 0) text += " — only the current tab is searched, try switching tabs.";
        return text;
    }

    function findDialog() {
        return document.querySelector(DIALOG_SELECTOR);
    }

    function activePanel(dialog) {
        // The visible React panel (custom coordinator panels are excluded).
        const panels = [];
        for (const panel of dialog.querySelectorAll(PANEL_SELECTOR)) {
            panels.push({ display: panel.style.display, el: panel });
        }
        return activePanelOf(panels);
    }

    // Applies the current query to the active panel and updates the status
    // line. Pure decisions come from filterPlan/sectionsToHide; this only
    // touches the DOM they pointed at.
    function applyNow() {
        if (!ui || !ui.root.isConnected) return;
        const dialog = findDialog();

        // Restore everything before (re)filtering so the plan is applied to
        // a clean slate (also covers tab switches mid-query).
        restore.clear();

        const panel = dialog ? activePanel(dialog) : null;
        if (!panel || query.trim() === "") {
            if (ui.status.textContent !== "") ui.status.textContent = "";
            ui.clearBtn.style.display = "none";
            return;
        }

        const subsectionTexts = [];
        for (const sub of panel.querySelectorAll(SUBSECTION_SELECTOR)) {
            if (ui.root.contains(sub)) continue; // never hide our own UI
            subsectionTexts.push({ el: sub, text: sub.textContent });
        }
        const plan = filterPlan({ subsectionTexts, query });
        for (const node of plan.hide) restore.add(node);

        // Hide sections left with zero visible subsections.
        const sections = [];
        for (const section of panel.querySelectorAll(SECTION_SELECTOR)) {
            const subs = Array.from(section.querySelectorAll(SUBSECTION_SELECTOR));
            if (subs.length > 0) sections.push({ el: section, subsections: subs });
        }
        for (const node of sectionsToHide(sections)) restore.add(node);

        const statusText = buildStatusLine(query, plan);
        if (ui.status.textContent !== statusText) ui.status.textContent = statusText;
        ui.clearBtn.style.display = query ? "" : "none";
    }

    function clearQuery() {
        if (!ui) return;
        query = "";
        ui.input.value = "";
        applyFilter.cancel();
        scheduleApply();
        ui.input.focus();
    }

    function buildUI() {
        const root = el("div");
        root.setAttribute("data-settings-search", "true");
        root.style.cssText = "margin-bottom:8px;box-sizing:border-box;min-width:0;";

        const row = el("div");
        row.style.cssText =
            "box-sizing:border-box;min-width:0;display:flex;align-items:center;gap:8px;padding:8px 12px;" +
            "background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";

        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Search settings…";
        input.value = query; // restore state across tab switches / reopens
        input.setAttribute("aria-label", "Search settings");
        input.style.cssText =
            "min-width:0;width:100%;box-sizing:border-box;flex:1 1 auto;padding:6px 10px;border-radius:8px;" +
            "border:1px solid var(--cpd-color-border-disabled,#ccc);background:transparent;" +
            "color:inherit;font:inherit;";
        input.addEventListener("input", () => {
            query = input.value;
            applyFilter();
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                clearQuery();
            }
        });

        const clearBtn = el("button", null, "✕");
        clearBtn.type = "button";
        clearBtn.setAttribute("aria-label", "Clear search");
        clearBtn.style.cssText =
            "flex:0 0 auto;display:none;padding:4px 8px;border:none;border-radius:8px;cursor:pointer;" +
            "background:transparent;color:var(--cpd-color-text-secondary,inherit);font:inherit;";
        clearBtn.addEventListener("click", clearQuery);

        const status = el("div");
        status.setAttribute("aria-live", "polite");
        status.style.cssText =
            "font-size:12px;color:var(--cpd-color-text-secondary,inherit);padding:0 12px 8px;";

        row.appendChild(input);
        row.appendChild(clearBtn);
        root.appendChild(row);
        root.appendChild(status);
        return { root, input, clearBtn, status };
    }

    // Called on every mutation batch: (re)inject the search UI as the first
    // child of the ACTIVE tab panel (a new panel after a tab switch has no
    // node of ours; a React re-render may have wiped or remounted it), and
    // re-apply the stored query. Idempotent: rebinding to an existing node
    // never re-attaches listeners (those are only attached at build time).
    function sync() {
        const dialog = findDialog();
        if (!dialog) {
            // Dialog closed: drop UI handles but keep the stored query so a
            // reopen restores the search state; still un-hide anything.
            ui = null;
            restore.clear();
            return;
        }

        const panels = [];
        for (const panel of dialog.querySelectorAll(PANEL_SELECTOR)) {
            panels.push({ display: panel.style.display, el: panel });
        }
        const panel = activePanelOf(panels);
        if (!panel) return; // only a custom modding tab is active — inject nothing

        // Guard against double-insert: if our node is already inside the
        // active panel (React re-rendered around it), rebind handles to it.
        const existing = panel.querySelector(":scope > [data-settings-search]");
        if (existing) {
            if (!ui || ui.root !== existing) {
                ui = {
                    root: existing,
                    input: existing.querySelector("input"),
                    clearBtn: existing.querySelector("button"),
                    status: existing.querySelector('[aria-live="polite"]'),
                };
            }
        } else {
            ui = buildUI();
            panel.insertBefore(ui.root, panel.firstChild);
        }

        const tab = panel.querySelector(".mx_SettingsTab");
        ui.root.style.marginRight = rightInsetFor(tab ? getComputedStyle(tab).paddingRight : "");

        if (query.trim() !== "") scheduleApply();
    }

    function onDocumentClick(event) {
        const target = event.target;
        if (!target || typeof target.closest !== "function") return;
        const dialog = findDialog();
        if (!dialog || !dialog.contains(target)) return;
        if (target.closest(".mx_TabbedView_tabLabel")) applyFilter();
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    function start() {
        if (started) return;
        started = true;
        scheduleApply = createFrameScheduler(applyNow);
        applyFilter = createDebounce(scheduleApply, DEBOUNCE_MS);
        observer = new MutationObserver((records) => {
            if (hasForeignMutation(records, ui ? ui.root : null)) sync();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("click", onDocumentClick, true);
        sync();
    }

    function stop() {
        if (!started) return;
        started = false;
        if (observer) observer.disconnect();
        observer = null;
        if (applyFilter) applyFilter.cancel();
        if (scheduleApply) scheduleApply.cancel();
        scheduleApply = null;
        document.removeEventListener("click", onDocumentClick, true);
        restore.clear();
        if (ui) {
            ui.root.remove();
            ui = null;
        }
    }

    window.mods.registerPatch(PATCH_ID, {
        start,
        stop,
        _test: {
            matchesQuery,
            hasForeignMutation,
            rightInsetFor,
            filterPlan,
            sectionsToHide,
            createRestoreSet,
            createDebounce,
            createFrameScheduler,
            buildStatusLine,
            activePanelOf,
        },
    });
})();
