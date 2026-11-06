/*
Patch: adds a "Modding" tab to the Settings dialog.

The Settings dialog (new Element Web / Compound UI) renders its tabs through a
TabbedView: a <ul class="mx_TabbedView_tabLabels"> of <li class="mx_TabbedView_tabLabel">
labels and a single active <div class="mx_TabbedView_tabPanel">. We can't easily
register a real React tab from the page world, so this patch injects its own tab
label + panel. Rather than managing the tab list directly (which breaks when
several patches add tabs), it registers with the shared coordinator exposed by
the loader as window.mods.settingsTabs.

The panel shows info about the mod platform, a per-patch enable/disable switch
(backed by window.mods.setPatchEnabled / isPatchEnabled), and an "Apply &
Restart" button that reloads the webapp.
*/
(() => {
    "use strict";

    const TAB_ID = "modding";
    const PANEL_ID = `mx_tabpanel_${TAB_ID}`;
    const SELF_ID = "modding-tab";

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function createTabLabel() {
        const li = el("li", "mx_TabbedView_tabLabel");
        li.setAttribute("role", "tab");
        li.setAttribute("tabindex", "0");
        li.setAttribute("aria-controls", PANEL_ID);
        li.setAttribute("aria-selected", "false");
        li.setAttribute("data-testid", `settings-tab-${TAB_ID}`);

        const icon = document.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.style.cssText = "display:inline-flex;margin-inline-end:8px;color:var(--cpd-color-icon-primary,inherit);";
        icon.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h6"/><path d="M8 17h4"/></svg>';

        li.appendChild(icon);
        li.appendChild(el("span", "mx_TabbedView_tabLabel_text", "Modding"));
        return li;
    }

    function createSwitch(checked, onChange, disabled) {
        const wrap = el("span");
        wrap.style.cssText =
            "position:relative;display:inline-block;width:38px;height:22px;flex:0 0 auto;cursor:pointer;";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!checked;
        input.style.cssText =
            "position:absolute;inset:0;z-index:1;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;";

        const track = el("span");
        track.style.cssText =
            "position:absolute;inset:0;border-radius:999px;background:#d3d3d3;transition:background .15s ease;pointer-events:none;";

        const knob = el("span");
        knob.style.cssText =
            "position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;" +
            "background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s ease;pointer-events:none;";

        function paint() {
            track.style.background = input.checked ? "var(--cpd-color-bg-action-primary,#0dbd8b)" : "#d3d3d3";
            knob.style.transform = input.checked ? "translateX(16px)" : "translateX(0)";
        }
        paint();

        if (disabled) {
            input.disabled = true;
            wrap.style.opacity = "0.5";
            wrap.style.cursor = "default";
        }

        input.addEventListener("change", () => {
            paint();
            if (onChange) onChange(input.checked);
        });

        wrap.appendChild(input);
        wrap.appendChild(track);
        wrap.appendChild(knob);
        return wrap;
    }

    function patchRow(p, enabled, toggleable, disabled) {
        const item = el("div");
        item.style.cssText =
            "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;" +
            "background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";

        const left = el("div");
        const name = el("span", null, p.name);
        name.style.cssText = "font-weight:600;";
        const version = el("span", null, ` v${p.version}`);
        version.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);";
        const title = el("div");
        title.appendChild(name);
        title.appendChild(version);
        const desc = el("div", null, p.description || "");
        desc.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;";
        left.appendChild(title);
        left.appendChild(desc);

        item.appendChild(left);

        if (toggleable) {
            item.appendChild(
                createSwitch(
                    enabled,
                    (checked) => {
                        window.mods.setPatchEnabled(p.id, checked);
                        refreshPanel();
                    },
                    disabled,
                ),
            );
        } else {
            const badge = el("span", null, "Always enabled");
            badge.style.cssText =
                "flex:0 0 auto;font-size:11px;color:var(--cpd-color-text-secondary,inherit);" +
                "border:1px solid var(--cpd-color-border-disabled,#e0e0e0);border-radius:999px;padding:2px 8px;";
            item.appendChild(badge);
        }

        return item;
    }

    function createPanelContent() {
        const modInfo = window.mods.getModInfo();
        const patches = window.mods.getPatches();

        const content = el("div");
        content.style.cssText = "padding:24px;max-width:680px;";

        const title = el("h3", null, modInfo.name);
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);";
        content.appendChild(title);

        const version = el("div", null, `Version ${modInfo.version}`);
        version.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:16px;";
        content.appendChild(version);

        // Master pause toggle: stops every non-required patch while keeping
        // this tab (required) alive so the user can always unpause.
        const paused = window.mods.isPaused();
        const pauseRow = el("div");
        pauseRow.style.cssText =
            "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;" +
            "background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";
        const pauseLeft = el("div");
        const pauseLabel = el("span", null, "Pause all mods");
        pauseLabel.style.cssText = "font-weight:600;";
        const pauseHint = el("div", null, "Stops every patch except this tab. Per-patch switches are remembered.");
        pauseHint.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;";
        pauseLeft.appendChild(pauseLabel);
        pauseLeft.appendChild(pauseHint);
        pauseRow.appendChild(pauseLeft);
        pauseRow.appendChild(
            createSwitch(paused, (checked) => {
                window.mods.setPaused(checked);
                refreshPanel();
            }),
        );
        content.appendChild(pauseRow);

        const divider = el("hr");
        divider.style.cssText = "border:none;border-top:1px solid var(--cpd-color-border-disabled,#e0e0e0);margin:16px 0;";
        content.appendChild(divider);

        const subtitle = el("div", null, "Installed patches");
        subtitle.style.cssText = "font:var(--cpd-font-heading-sm-semibold,600 14px/1.4 sans-serif);margin-bottom:8px;";
        content.appendChild(subtitle);

        if (patches.length === 0) {
            content.appendChild(el("div", null, "No patches installed."));
        } else {
            const list = el("div");
            list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
            for (const p of patches) {
                const toggleable = !p.required;
                const enabled = toggleable ? window.mods.isPatchEnabled(p.id) : true;
                const row = patchRow(p, enabled, toggleable, paused);
                if (paused && toggleable) {
                    row.style.opacity = "0.5";
                }
                list.appendChild(row);
            }
            content.appendChild(list);
        }

        let applyBtn;
        if (paused) {
            applyBtn = el("button", null, "Restart with mods");
            applyBtn.addEventListener("click", () => {
                window.mods.setPaused(false);
                window.mods.reload();
            });
        } else {
            applyBtn = el("button", null, "Apply & Restart");
            applyBtn.addEventListener("click", () => {
                window.mods.reload();
            });
        }
        applyBtn.type = "button";
        applyBtn.style.cssText =
            "margin-top:20px;padding:8px 16px;border:none;border-radius:8px;" +
            "background:var(--cpd-color-bg-action-primary,#0dbd8b);color:#fff;" +
            "font:var(--cpd-font-body-md-semibold,600 15px/1.5 sans-serif);cursor:pointer;";
        content.appendChild(applyBtn);

        const hintText = paused
            ? "Paused: no patches except this tab are running. Restart unpauses and reloads with your saved set."
            : "Toggles apply instantly and are saved. Restart reloads Element with the current set.";
        const hint = el("div", null, hintText);
        hint.style.cssText = "margin-top:8px;font-size:12px;color:var(--cpd-color-text-secondary,inherit);";
        content.appendChild(hint);

        return content;
    }

    function renderContent(scroller) {
        scroller.textContent = "";
        scroller.appendChild(createPanelContent());
    }

    function createPanel() {
        const panel = el("div", "mx_TabbedView_tabPanel");
        panel.id = PANEL_ID;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", `${PANEL_ID}_label`);
        panel.setAttribute("data-modding-panel", "true");

        const scroller = el("div", "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent");
        renderContent(scroller);
        panel.appendChild(scroller);
        return panel;
    }

    function refreshPanel() {
        const panel = document.querySelector("[data-modding-panel]");
        if (!panel) return;
        const scroller = panel.querySelector(".mx_TabbedView_tabPanelContent");
        if (scroller) renderContent(scroller);
    }

    let registered = false;

    function start() {
        window.mods.settingsTabs.register(TAB_ID, { label: createTabLabel(), renderPanel: createPanel });
        registered = true;
    }

    function stop() {
        if (registered) window.mods.settingsTabs.unregister(TAB_ID);
        registered = false;
    }

    window.mods.registerPatch(SELF_ID, { start, stop });
})();
