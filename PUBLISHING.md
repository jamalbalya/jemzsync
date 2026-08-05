# Publishing jemzsync to the Obsidian community plugins

The path from this repo to the in-app plugin browser.

**The submission process changed in 2026.** You no longer fork
`obsidianmd/obsidian-releases` and open a pull request against
`community-plugins.json`. Submission now happens through a developer dashboard
on the Community site, and review is automated: results usually arrive within
minutes rather than weeks. Any guide telling you to open a PR is out of date.

## Step 0 — Make the repo public

Blocking. A private repo cannot be submitted; the reviewer reads the source.

GitHub → the repo → **Settings** → **General** → **Danger Zone** →
**Change repository visibility** → **Make public**.

## Step 1 — Confirm the layout

The automated review checks these:

- `manifest.json`, `README.md` and `LICENSE` are at the **repo root**, not in a
  subfolder
- The `id` in `manifest.json` is unique across the directory and does not
  contain the word "obsidian" — check https://obsidian.md/plugins
- No sample-plugin leftovers from `obsidian-sample-plugin`
- **`package.json` has a `build` script.** Not optional. See below.

## Step 1a — `package.json` must have a `build` script

This one cost 2.0.1 its listing, so it is worth stating plainly.

Obsidian's review reproduces the release from source and compares the result
against the published asset. It runs `npm run build` to do that. With no
`build` script it cannot even start, and the scorecard reports:

```
HIGH  Release build could not be verified against the private source repository
INFO  Build verification could not run because package.json has no build script
INFO  Build verification not available.
INFO  Malware scan not available.
INFO  Obfuscation scan not available.
INFO  Network requests scan not available.
```

Two traps in that output:

- **"private source repository" does not mean your repo is private.** It is the
  canned wording for "could not verify the release build against source". 2.0.1
  was flagged this way while the repo was verifiably public, and a review
  request arguing the repo was public went nowhere, because being public was
  never the finding.
- **The malware, obfuscation and network scans are downstream of build
  verification.** They do not fail independently; they simply cannot run. Fix
  the build script and all four clear at once.

A plugin with no compiler still needs the script. `build.js` here copies
`src/main.js` and stamps the version onto it. What matters is that the output
is deterministic — no timestamps, no build host, no filesystem ordering — so
the reproduction is byte-identical. `npm run build:check` asserts exactly that,
and the release workflow runs it before it will publish anything.

## Step 2 — Cut a release

The workflow in `.github/workflows/release.yml` does this. Tag and push:

```bash
git tag 2.0.2
git push origin 2.0.2
```

That proves `main.js` reproduces from `src/`, runs the test suite, verifies the
tag equals the manifest version, and
publishes a release with `main.js`, `manifest.json` and `styles.css` attached
as **individual assets**.

Two rules the tag must follow:

- Bare version, `2.0.1` — **not** `v2.0.1`
- Exactly equal to `version` in `manifest.json`

Then open the Releases page and confirm the three files are attached
separately. A source-code zip alone is not enough; Obsidian downloads the
individual assets.

## Step 3 — Use the released build yourself first

Install from your own release on a Mac and an iPhone and live with it for a
few days. Automated review checks policy and code, not whether the thing
actually works. The tests here cannot cover the Obsidian UI or real iCloud
timing on real hardware — only you can.

## Step 4 — Submit through the developer dashboard

1. Sign in at https://community.obsidian.md with your Obsidian account
2. Connect the GitHub account that owns this repo, so ownership is verified
3. **Plugins** → **New plugin**
4. Enter the repository URL
5. Read and agree to the developer policies and the support expectations
6. Submit

Automated review runs immediately. Results typically appear within a few
minutes. If it passes, the plugin becomes searchable and installable in the
app within 24 hours.

If it fails, the dashboard says what to fix. Correct it here, then **cut a new
release with an incremented version** — resubmission reads the latest release,
so bumping the version is required, not optional.

## Step 5 — Shipping updates afterwards

No dashboard visit needed. Bump `manifest.json`, `versions.json` and
`package.json` together, tag, push the tag. The workflow releases it and
Obsidian's updater picks it up.

Note that automated review now scans **every version**, not just the first
submission. A later release can be flagged even though the original passed.

## Requirements this repo already satisfies

- [x] `manifest.json` at root with every required field
- [x] `id` (`jemzsync`) contains no "obsidian" and is unique
- [x] Description is 156 characters, opens with an action verb, ends with a
      period, no emoji, does not begin with "This is a plugin"
- [x] `isDesktopOnly: false`, and genuinely no Node.js or Electron APIs —
      the audit greps for `fs`, `path`, `os`, `child_process`, `electron`
- [x] Command ids omit the plugin id, which Obsidian prefixes itself
- [x] No `innerHTML`/`outerHTML`; the DOM is built with `createEl`
- [x] Leaves are not detached in `onunload`
- [x] `this.app` throughout; the global `app` is never touched
- [x] Styling lives in `styles.css` against theme CSS variables, no hardcoded
      colours
- [x] No sample-plugin code
- [x] `LICENSE` (MIT) at root
- [x] README discloses network use (`api.github.com` only, opt-in), the account
      requirement (GitHub storage only), and where the access token is stored —
      all policy disclosure requirements. There is still no telemetry.
- [x] `versions.json` maps plugin version to minimum app version, and every
      entry in it corresponds to a real tag and release
- [x] `package.json` has a `build` script, and `npm run build` is deterministic
      so the release reproduces byte-for-byte from source
- [x] Tests (`npm test`) and mutation verification (`npm run test:mutation`)
- [x] No Node.js or Electron API anywhere, verified by grep — the plugin runs
      unchanged on iOS and Android
- [x] One network host only (`api.github.com`), reached solely through
      Obsidian's own `requestUrl`, and never contacted until a token is entered
- [x] The access token is stored through `app.saveLocalStorage`, never through
      `saveData` — it must not enter the vault, which is replicated by iCloud
      and committed to the repository
- [x] The plugin never syncs its own files to the repository, so it cannot
      distribute or update itself

## Worth deciding before you submit

**The plugin name is all lowercase.** `jemzsync` is valid, but the directory
mostly uses title case and Obsidian's style guide asks for correct
capitalisation. `Jemzsync` reads better next to the other entries. Changing
`name` in `manifest.json` is safe at any time; changing `id` after acceptance
is not, so leave the id alone.

**`minAppVersion` is `1.4.0`.** Only lower it if you have actually tested that
far back. Raising it later is fine.

## References

- Submit your plugin — https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
- Submission requirements — https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
- Developer policies — https://docs.obsidian.md/Developer+policies
- Announcement of the new process — https://obsidian.md/blog/future-of-plugins/
