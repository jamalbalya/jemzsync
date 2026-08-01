# jemzsync

Check that your Obsidian vault is set up to sync across your devices, confirm the sync actually worked, and clean up the duplicate files a sync engine leaves behind.

jemzsync works out which ecosystem it is running in and checks the vault against the right cloud: iCloud Drive on Apple devices, Google Drive on Windows and Android. While Obsidian is open it watches the vault and re-checks within seconds of anything changing — including files arriving from the other device.

Works on macOS, iPadOS, iOS, Windows, Android and Linux.

---

## Read this first: what this plugin does and does not do

**iCloud Drive moves your files. jemzsync tells you whether it is working.**

An Obsidian plugin cannot sign in to an Apple Account, and jemzsync does not try. Reading or writing iCloud on your behalf requires a signed native app holding Apple's iCloud entitlement, granted only to apps built with a paid Apple Developer account. Plugins are JavaScript running inside Obsidian's sandbox: no entitlement, no Apple Account access, and on iPhone and iPad no access to any file outside the vault.

So jemzsync never asks for your Apple Account, never sees your password, and sends nothing anywhere. It has no network code at all.

What it does instead is fix the reason your notes are not showing up. Apple's sync already works — the usual problem is that the vault is in a folder your iPhone cannot see. jemzsync finds that, tells you exactly how to fix it, and then proves the fix worked.

| | Handled by |
|---|---|
| Moving file contents between devices | iCloud Drive / Google Drive |
| Saving what you type into the vault | Obsidian, as you type |
| Signing in to your Apple or Google Account | The Settings app, once per device |
| Creating or switching vaults | You, in Obsidian's vault picker |
| Working out which cloud this device should use | **jemzsync** |
| Checking the vault is in a folder that cloud can reach | **jemzsync** |
| Warning you up front when it is not | **jemzsync** |
| Watching the vault and re-checking as things change | **jemzsync** |
| Proving both devices hold the same notes | **jemzsync** |
| Finding files the cloud has not downloaded yet | **jemzsync** |
| Resolving duplicate copies after an offline edit | **jemzsync** |

### Four things people ask for that no plugin can do

These are worth stating plainly, because they sound reasonable and are not possible from inside Obsidian:

- **Create the vault in iCloud or Google Drive for you.** A plugin runs *inside* a vault that is already open. It cannot create a vault elsewhere, cannot move the one it is in, and has no file access outside it. On Apple the iCloud container is worse than merely restricted — only Obsidian itself can register it, so a folder made by hand or by script never syncs.
- **Log in to iCloud or Google Drive.** No entitlement, no OAuth, no network code at all.
- **Run in the background when Obsidian is closed, or start itself after a reboot.** A plugin lives and dies with Obsidian. The good news is you do not need it to: iCloud Drive and Google Drive keep syncing on their own, as system services, whether Obsidian is open or not. To have Obsidian itself come back after a restart, add it to your login items.
- **Sync faster than the cloud does.** Obsidian saves your notes into the vault folder as you type; the cloud client uploads from there. jemzsync's watcher makes the *checking* live, not the transport.

---

## Why your Mac notes are not on your iPhone

Almost always one of these three.

**1. The vault is in the wrong iCloud folder.** This is the big one. Obsidian on iPhone and iPad only lists vaults from its own private iCloud container:

```
iCloud Drive/Obsidian/YourVault
```

A vault in `iCloud Drive/Documents/YourVault`, or any other iCloud folder, syncs perfectly well — you will see the files in the Files app — but mobile Obsidian will never list it. The folder must be the one carrying the Obsidian icon. A folder you create by hand and name "Obsidian" will not work; only the app can create the real one.

**2. The vault is stored locally.** A vault under `~/Documents`, `~/Desktop` or anywhere else on the Mac has nothing replicating it. Turning on "Desktop & Documents Folders" in iCloud settings does not help — mobile Obsidian still only reads its own container.

**3. iCloud offloaded the files.** To save disk space, iCloud replaces file contents with small placeholder stubs named like `.YourNote.md.icloud`. Obsidian cannot read a placeholder. The note appears missing or empty even though sync is working.

jemzsync detects all three.

---

## Install

There is no build step. `main.js` is plain JavaScript that Obsidian loads directly, which is also why the same files work on iPhone and iPad where you cannot run a compiler.

### On your Mac

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/jamalbalya/jemzsync/releases).
2. Put all three into your vault at `YourVault/.obsidian/plugins/jemzsync/`.
   The folder name must be exactly `jemzsync`.
3. In Obsidian: **Settings → Community plugins**, turn off Restricted mode if it is on, then **Reload plugins**.
4. Enable **jemzsync**.

### On your iPhone or iPad

If your vault is already syncing through iCloud, the plugin arrives on its own — it lives inside the vault folder. Just enable it in **Settings → Community plugins**.

If it is not syncing yet, fix that first using the steps below, then enable the plugin.

### Using BRAT instead

If you have the BRAT plugin, add `jamalbalya/jemzsync` and it will install and auto-update for you.

---

## Setting up iCloud sync, start to finish

Do this once. Back up your vault before you start — copy the whole folder somewhere outside iCloud.

**Step 1 — Same Apple Account everywhere.** On each device, open Settings and confirm you are signed in to the same account with iCloud Drive turned on.

**Step 2 — Create the container from your iPhone.** This step is the one people skip, and skipping it is why the rest fails.

- Open Obsidian on the iPhone.
- Create a new vault and turn on **Store in iCloud**.
- Name it whatever you like; you can delete it later.

This is what creates the real `Obsidian` folder in iCloud Drive. Only the app can create it correctly.

**Step 3 — Move your Mac vault into that folder.** Open jemzsync on the Mac and press **Scan now**. If the vault is in the wrong place, the panel gives you the exact Terminal commands, ready to copy. They back up first and never delete your original.

Or do it in Finder: copy the vault folder into **iCloud Drive → Obsidian**.

**Step 4 — Open the copy on the Mac.** In Obsidian choose **Open folder as vault**, then pick `iCloud Drive → Obsidian → YourVault`. Wait for the first sync to finish before editing anything on a second device.

**Step 5 — Keep it downloaded.** In Finder, right-click the Obsidian folder in iCloud Drive and choose **Keep Downloaded**. This stops iCloud from offloading your notes into placeholders.

**Step 6 — Open the same vault on the iPhone.** Obsidian will now list it. Open it and let it finish downloading.

**Step 7 — Confirm it worked.** See below.

---

## Devices see each other automatically

Once jemzsync is enabled in the same vault on two devices, they find each other on their own — no server, no account, no setup.

Each device writes one small file into a hidden `.jemzsync` folder inside the vault, announcing its name and a **fingerprint** of its files. iCloud carries that file across with your notes. The panel's **Devices** card then shows every device in this vault, when it last checked in, and whether its files match this one — line by line:

- **Same files as this device.** Sync is working, proven end to end. The announcement arriving at all means data flowed from that device to this one.
- **The other device has N more files.** Sync is lagging or stuck; the card tells you which side is behind.
- **Quiet for a while.** That device hasn't opened Obsidian in two days; its state is old news, not necessarily wrong.

Beacons are excluded from the fingerprint itself, so writing one never triggers a false mismatch, and are refreshed at most every 5 minutes so iCloud isn't churned. Turn announcing off in settings if you prefer.

You can still compare by hand: **Copy vault fingerprint** on one device, paste into **Other device fingerprint** in settings on the other. Matching codes mean identical notes.

If they do not match, jemzsync tells you which device has more files. Wait a few minutes for iCloud and scan again.

The fingerprint deliberately ignores things that differ between devices for harmless reasons: modification times (iCloud restamps files), `.obsidian/workspace*` (your pane layout is meant to be per-device), `.DS_Store`, and the `.jemzsync` folder itself. Without those exclusions two perfectly synced devices would report a mismatch.

---

## Resolving conflicts

When two devices edit the same note before seeing each other, iCloud keeps both — as `Note 2.md`, or a name containing "conflicted copy". Nothing is lost, but you end up with duplicates.

jemzsync lists each one and gives you two choices:

- **Keep newest** — keeps the most recently modified version and moves the others to Obsidian's trash. On a tie, the larger file wins; on a full tie, the original.
- **Merge both** — appends the other version to the original under a clearly marked banner, so you can decide by hand. Nothing is discarded.

Both send removed files to the trash rather than deleting them, so a wrong choice is recoverable.

`Chapter 2.md` is only ever flagged when `Chapter.md` exists in the same folder. Numbered notes on their own are left alone.

---

## Commands

Open the command palette and search for jemzsync.

| Command | What it does |
|---|---|
| Open panel | Opens the sidebar |
| Check iCloud setup | Scans and reports whether the vault is in the right place |
| Scan for sync conflicts | Looks for duplicate copies |
| Copy vault fingerprint | Copies the fingerprint for comparison |

There is also a cloud icon in the left ribbon and a status bar summary.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| This device's name | Mac / iPhone / iPad | How the device introduces itself to the others. Stored per device, never synced |
| Announce this device | On | Writes the small beacon file other devices read |
| Watch the vault while Obsidian runs | On | Rescans a few seconds after anything changes, including files arriving from the cloud. Needs a restart |
| Warn when the vault cannot sync | On | Popup on launch if the vault is somewhere the cloud cannot reach |
| Scan when Obsidian starts | On | Checks the vault on launch |
| Scan every | 15 minutes | Background scans. 0 means on demand only |
| Notify about conflicts | On | Shows a notice when duplicates appear |
| Show status bar item | On | One-line summary. Needs a restart |
| Other device fingerprint | Empty | Paste from your other device to compare |
| Other device name | Empty | A label so you remember which device |

---

## On Windows, Android and Linux

jemzsync reads Obsidian's platform flags on load and picks the cloud that ecosystem can actually use. You do not configure this.

| Device | Cloud checked for | Vault belongs in |
|---|---|---|
| Mac, iPhone, iPad | iCloud Drive | `iCloud Drive/Obsidian/YourVault` |
| Windows | Google Drive | `My Drive\YourVault` (any drive letter) |
| Android | Google Drive | see the caveat below |
| Linux | Google Drive | whatever folder your client watches |

OneDrive and Dropbox are recognised too. If your vault is already inside one of those, jemzsync reports it as fine rather than nagging you to move it — they replicate a folder just as well as Google Drive does.

**iCloud Drive on Windows is a special case.** iCloud for Windows exists, and it does replicate the folder, so your notes genuinely travel between an iPad and a PC. But Obsidian's own documentation warns that iCloud Drive on Windows can duplicate or corrupt files, and no plugin can prevent that. jemzsync therefore reports it as *syncing but risky* rather than pretending it is either fine or broken — and the conflicts card is where the damage shows up when it happens. If you need a PC in the mix, Google Drive or Obsidian Sync is the safer foundation.

**The Android caveat.** Google Drive is not the equivalent of iCloud here. The Drive app does not expose a folder that Obsidian can read and write continuously, so putting the vault "in Google Drive" on Android does not work the way it does on Windows. The workable options are a folder-sync app (FolderSync, Autosync for Google Drive) pointed at the Drive folder, or Obsidian Sync. jemzsync says so directly rather than sending you in a circle.

---

## Watching the vault

With **Watch the vault** on, jemzsync subscribes to Obsidian's vault events and rescans about eight seconds after the last change. That covers files you edit and files that arrive from your other device, so the panel and the fingerprint stay current without waiting for the 15-minute poll.

The eight-second delay is deliberate: it collapses a burst of typing, or a batch of files landing from the cloud, into a single scan.

One thing this must never do is react to its own beacon. Writing a beacon is a vault change, so an unfiltered watcher would scan, write a beacon, notice the write, and scan again — forever, on every device at once. Beacons are therefore excluded twice over, by path prefix and by an explicit beacon check, and both halves are asserted by tests and by a mutation that removes the guard.

---

## Troubleshooting

**The vault does not appear on my iPhone.** It is in the wrong folder. It must be inside `iCloud Drive/Obsidian/` — the folder with the Obsidian icon. Follow Step 2 above to create it properly.

**Notes appear but are empty.** iCloud offloaded them. jemzsync reports these as "not downloaded". On the Mac, right-click the Obsidian folder and choose "Keep Downloaded". On the iPhone, open the vault in Files and pull down.

**Changes take a long time to appear.** iCloud syncs on its own schedule and slows down on battery or a poor connection. Opening the Files app on the iPhone often prompts it along. If a device is stuck for hours, toggle iCloud Drive off and on in Settings.

**I keep getting conflicts.** Let one device finish syncing before editing on another. Fully closing Obsidian on the device you are leaving helps it flush changes.

**The plugin does not appear after installing.** Check the folder is named exactly `jemzsync` and contains all three files, then use **Reload plugins**.

**Fingerprints will not match.** Confirm both devices really opened the same vault in the iCloud folder, not two separate vaults with the same name. Also check for files still downloading.

---

## Privacy

- No network requests. There is no networking code in this plugin.
- No Apple Account, password, email or credential is requested, stored or transmitted.
- Nothing leaves your device. Scan results live in memory; only your own settings are saved, into your vault.
- The only things written to your vault are conflict resolutions you explicitly ask for, and (if announcing is on) one small JSON file per device under `.jemzsync/` containing a device name you chose, a random ID, and file counts — never note contents, never an email or account.

### Two behaviours worth explaining

Obsidian's automated review flags both of these. Neither is accidental.

**Clipboard.** The plugin writes to the clipboard, never reads it. It happens only when you press a button: **Copy** on the fingerprint, **Copy commands** on the migration steps, or the *Copy vault fingerprint* command. What lands there is a sixteen-character digest or a block of shell commands. Nothing is read back, and nothing is copied without a click.

**Per-device state kept out of `saveData`.** Obsidian's `saveData` writes into the vault — and this vault is being replicated by iCloud or Google Drive, which is the entire point of the plugin. Two pieces of state must *not* travel:

- **The device ID.** Every device needs a different one. Stored through `saveData`, the first device's ID would sync to the second, both would claim the same identity, and the Devices panel could never tell them apart.
- **The "don't warn me again" dismissal.** Dismissing the setup warning on a correctly configured Mac must not silence it on an iPhone that is still misconfigured.

Both go through `app.saveLocalStorage` / `app.loadLocalStorage`, Obsidian's own API for exactly this: stored on the device, never synced, and scoped per vault — so two vaults open on the same Mac get separate identities rather than quietly sharing one. Everything that *should* be shared — scan preferences, exclusions, the paired fingerprint — goes through `saveData` as normal.

Nine tests drive this against a fake app, including that two vaults never collide, that a dismissal in one does not silence another, and that a build without the storage API degrades to an ephemeral ID instead of throwing.

---

## For developers

```bash
git clone https://github.com/jamalbalya/jemzsync.git
cd jemzsync
npm test
```

99 tests, no dependencies, no build step. The suite covers vault-location detection, the migration plan, conflict grouping and resolution, fingerprinting, device beacons, and the scanner driven by a fake adapter — including end-to-end simulations of a Mac beacon being read on an iPhone for both the matching and the missing-note case.

The suite is itself verified by mutation testing (`npm run test:mutation`): 20 deliberate regressions are injected into a temporary copy of the source and all 20 must be caught, including an infinite-loop hang.

Layout:

```
main.js             plugin + core logic (no build step)
manifest.json       plugin metadata
styles.css          panel styling via Obsidian theme variables
test/test-core.js   test suite
test/mutation.js    mutation testing of the suite itself
.github/workflows/  tag-triggered release pipeline (tests gate the release)
```

`main.js` splits into a pure core (no I/O, fully tested), a scanner using Obsidian's adapter, and the Obsidian integration. `module.exports.__core` exposes the core for testing.

Uses no Node.js or Electron APIs, so `isDesktopOnly` is `false` and it runs on iOS and iPadOS.

---

## If you want real sync instead

jemzsync makes iCloud reliable, but iCloud has real limits: Obsidian does not control it, and heavy editing on several devices at once causes conflicts. Alternatives:

- **Obsidian Sync** — official, paid, built for this, with version history.
- **Remotely Save** — free community plugin supporting S3, Dropbox, OneDrive, WebDAV, with end-to-end encryption.
- **Working Copy** — Git-based, good if you want full version control.

---

## Licence

MIT
