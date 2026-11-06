<p align="center">
  <img src="assets/logo.svg" width="96" alt="Element Mods logo">
</p>

<h1 align="center">Element Mods</h1>

<p align="center">
  Vencord-style mods for the <a href="https://element.io/">Element</a> (Matrix) desktop client.<br>
  Pick a patch, apply, restart. Undo any time.
</p>

<p align="center">
  <a href="https://github.com/jere344/element-modding/actions/workflows/ci.yml"><img src="https://github.com/jere344/element-modding/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-blue" alt="Node 18+">
</p>

---

Element Mods patches the app's bundled webapp to load a set of JavaScript mods.
Everything is local: no telemetry, no server, and every change can be reverted with one command.

> Unofficial project, not affiliated with Element or the Matrix.org Foundation.

## Requirements

- Node.js 18+
- A Linux install of Element (e.g. `/opt/Element-Nightly` or `/opt/Element`)

## Install

```sh
npm install
```

## Usage

Run commands from this directory with `node src/cli.js`. Since the app lives
in `/opt` (root-owned), any command that writes to it needs `sudo`:

```sh
node src/cli.js detect            # auto-detect the install path
node src/cli.js path /opt/Element-Nightly   # set the Element install path
sudo node src/cli.js apply        # patch Element
```

Then restart Element. All patches are loaded but disabled by default; toggle them on/off in
Settings -> Modding.

Other commands:

```sh
node src/cli.js list              # show available patches and patch status
node src/cli.js status            # show whether the app is currently patched
sudo node src/cli.js restore      # restore the original webapp
```

## Available patches

Click a patch to see its description.

<details>
<summary><b>Autocorrect</b></summary>

LanguageTool-style spelling and grammar checker for the message composer. Mistakes are underlined (red for spelling, blue for grammar); click one for suggestions, **Ignore** or **Disable rule**. It works with any LanguageTool-compatible backend, either your own server or the official API, configured in **Settings -> Autocorrect**.
</details>

<details>
<summary><b>Force User Status</b></summary>

Force-enables Element's built-in **MSC4426 User Status** feature (the emoji/text status row in your user menu and the status editor in Settings) even when your homeserver does not advertise support for the `org.matrix.msc4429` unstable feature it requires. Element silently force-disables that feature on servers that don't support it, so the setting alone does nothing — this patch bypasses the server-support check. Restart is recommended after enabling.

Works on any server, including matrix.org and custom servers.
</details>

<details>
<summary><b>Status Control</b></summary>

Lets you control your presence from your profile picture in the top-left corner. **Right-click** it to pick a status: **Online**, **Away**, **Offline**, **Busy** or **Automatic** (left-click keeps the normal user menu), and the chosen mode is forced on the server — Element's own idle/away logic can no longer change it. The current status is shown as a presence dot on your avatar.
</details>

<details>
<summary><b>GIF Picker</b></summary>

Adds a GIF picker button to the message composer to search GIFs from **Giphy** or **Klipy** (switchable via a dropdown in the picker header; your last choice is remembered) and send them into the current room.

<img width="1245" height="634" alt="image" src="https://github.com/user-attachments/assets/8716252f-2ef7-4479-afa6-c0abcd60f217" />


To use it you need a (free) API key for each provider:

1. **Giphy**: go to https://developers.giphy.com, sign in, click **Create an App** and copy the API key.
2. **Klipy**: go to https://partner.klipy.com/api-keys, create a platform, click **Create Key** and copy it.
3. In Element, open the GIF picker, pick the provider in the dropdown, and click the **gear** (⚙) icon in its header.
4. Paste the key into the field and press Enter.

Keys are stored locally in your browser's localStorage and never leave your machine.
</details>

<details>
<summary><b>Hidden Features</b></summary>

Adds a 'Hidden Features' tab to the Settings dialog with toggle switches for Element features that aren't exposed in the normal UI: the MSC4426 user-status system (status rows in your user menu/Settings plus an automatic 📞 on-call status), QR-code login, reaction images, developer mode, timeline debug panels, hidden-event display and more. Changes take effect after restarting the app.
</details>

<details>
<summary><b>Hide Room</b></summary>

Right-click a room and choose 'Hide room' to remove it from the room list. Hidden rooms are saved locally and can be unhidden from a 'Hidden rooms' tab in Settings.

<img width="345" height="331" alt="image" src="https://github.com/user-attachments/assets/9de85ad9-e210-4880-8134-01e5627235b5" />


</details>

<details>
<summary><b>Message Subscriptions</b></summary>

Creates **local-only subscription channels**: a channel that gathers every message containing a word you pick from a channel you pick, visible only to you (everything is stored locally, nothing is sent to any server). Configure subscriptions in **Settings -> Subscriptions** by choosing a source channel and typing a word. Each subscription appears as a button in the left sidebar, below the pinned rooms; clicking it opens a live view (newest first) of every matching message, with a button to jump to each one in its real room. It updates in real time as new matching messages arrive.

For example: choose the channel **Escalade Support-DEV** and the word **notidoc** — every message in that channel containing "notidoc" will appear in your new subscription channel.
</details>

<details>
<summary><b>Message Logger</b></summary>

Remembers message text locally and shows deleted messages in red, with a dismiss button that restores the grey 'Message deleted' placeholder.

<img width="416" height="156" alt="image" src="https://github.com/user-attachments/assets/50f9e8c0-b44d-4d8c-b691-b9978a3ea781" />

</details>

<details>
<summary><b>Modding Tab</b></summary>

Adds a 'Modding' tab to the Settings dialog showing the mod platform version and the list of active patches.

<img width="1028" height="866" alt="image" src="https://github.com/user-attachments/assets/e5e8504c-88ea-4967-8d3c-6af18b23523e" />

</details>

<details>
<summary><b>No Quick Settings</b></summary>

Removes the quick settings menu. Clicking the settings gear (bottom of the space panel) opens the full Settings page directly.
</details>

<details>
<summary><b>Pin Rooms</b></summary>

Pin/unpin rooms via the room right-click menu and show them as avatar buttons in the left sidebar, below the spaces.

<img width="155" height="320" alt="image" src="https://github.com/user-attachments/assets/16b4ba15-502e-4b56-a829-b5c6404ce454" />

</details>

<details>
<summary><b>Room List Sections</b></summary>

Adds a 'Room list' tab to the Settings dialog to show or hide each section of the conversation list (**Unreads**, **People**, **Rooms**, **Mentions**, **Invites**). It also adds a new **Latest** section that lists every conversation (rooms and chats together) in chronological order, from the most recent message to the oldest.

</details>

<details>
<summary><b>Save Message</b></summary>

Right-click a message to save it, and open a 'Saved messages' page from a new button in the left sidebar.

<img width="141" height="120" alt="image" src="https://github.com/user-attachments/assets/617e53f3-3f3e-4f2e-9af3-cd8a9a8c5b1f" />

<img width="1004" height="622" alt="image" src="https://github.com/user-attachments/assets/cb4a91b1-5a6b-445a-a579-1bb1977c34ed" />


</details>

<details>
<summary><b>Settings Search</b></summary>

Adds a search box at the top of the Settings dialog that filters the current tab's setting subsections as you type, showing a live result count. Press **Escape** or the ✕ button to clear the query and bring everything back. Only the currently open tab is searched — the status line reminds you to try switching tabs when nothing matches.
</details>

<details>
<summary><b>Themes</b></summary>

Theme engine modeled after Vencord's theme system: apply and manage custom CSS themes (bundled, added by URL, pasted, or **generated from an uploaded image** — a color palette is extracted from the image and turned into a theme automatically.

<img width="1055" height="866" alt="image" src="https://github.com/user-attachments/assets/0356add0-7b28-47b9-893f-7d7f4e9359d9" />

</details>

## Development

```sh
npm install
npm test        # validates manifests and runs patch self-checks
```

Patches live in `patches/<id>/` (a `manifest.json` plus an `index.js`). See [CONTRIBUTING.md](CONTRIBUTING.md) to write your own.

## Uninstall

```sh
sudo node src/cli.js restore
```

## License

[MIT](LICENSE)
