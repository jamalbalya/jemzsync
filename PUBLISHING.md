# Publishing jemzsync to the Obsidian community plugins

The whole path, from this repo to the in-app plugin browser. One important
expectation up front: the final step is a pull request that the Obsidian team
reviews by hand. Review commonly takes anywhere from days to several weeks,
and they may request changes. Everything before that step is fully in your
control.

## Step 1 — Push this repo to GitHub

From the folder containing this project:

```bash
git remote add origin https://github.com/jamalbalya/jemzsync.git
git push -u origin main
```

If the GitHub repo already has a commit (for example an auto-generated
README) the push will be rejected. If there is nothing there you want to
keep, force it:

```bash
git push -u origin main --force
```

## Step 2 — Confirm the layout GitHub shows

The Obsidian submission bot checks these, so eyeball them once:

- `manifest.json` is at the **repo root** (not in a subfolder)
- `README.md` and `LICENSE` are at the root
- The `id` in manifest.json is `jemzsync` and appears nowhere else in the
  community list (search https://obsidian.md/plugins to be sure)

## Step 3 — Cut a release

The release workflow in `.github/workflows/release.yml` does this for you:

```bash
git tag 1.1.0
git push origin 1.1.0
```

That triggers a run which executes the test suite, verifies the tag equals
the manifest version, and publishes a GitHub release with `main.js`,
`manifest.json` and `styles.css` attached as individual assets.

Rules the tag must follow (Obsidian requirements):

- The tag is the bare version: `1.1.0`, **not** `v1.1.0`
- It must exactly match `version` in `manifest.json`

Check the release at https://github.com/jamalbalya/jemzsync/releases and
confirm the three files are attached as assets (not just the source zip).

## Step 4 — Test the released build yourself first

Before submitting, install from your own release on at least your Mac and
iPhone and use it for a few days. The reviewers will expect the released
version to work, and you will catch anything the automated tests cannot see
(UI layout, real iCloud timing).

## Step 5 — Open the submission pull request

1. Fork https://github.com/obsidianmd/obsidian-releases
2. Edit `community-plugins.json` and add this entry **at the end** of the
   list:

```json
{
  "id": "jemzsync",
  "name": "jemzsync",
  "author": "jamalbalya",
  "description": "Check that an iCloud vault is set up correctly for Apple devices, compare vaults across devices, and resolve sync conflicts.",
  "repo": "jamalbalya/jemzsync"
}
```

3. Open a pull request. The PR template has a checklist — tick it honestly.
   A bot validates the entry within minutes and comments if something is
   off (fix, push to your fork, and it re-checks automatically).
4. Wait for human review. Respond to any requested changes by updating this
   repo and cutting a new release; the PR picks up the latest release.

## Step 6 — After acceptance

Once merged, the plugin appears in **Settings → Community plugins → Browse**
inside Obsidian for everyone. Future updates need no PR: bump the version in
`manifest.json` and `versions.json`, tag, and push the tag — the workflow
releases it and Obsidian's updater picks it up.

## Requirements checklist (already satisfied by this repo)

- [x] `manifest.json` at repo root, `id` matching the folder/plugin name
- [x] `isDesktopOnly: false` and no Node.js/Electron APIs (verified by audit)
- [x] Description under 250 characters, ends with a period, doesn't start
      with "This is a plugin"
- [x] README explaining what it does and how to use it
- [x] LICENSE file (MIT)
- [x] No network calls, no analytics, no credentials
- [x] `versions.json` mapping plugin version → minimum app version
- [x] Test suite (`npm test`) and mutation verification
      (`npm run test:mutation`)

Reference: https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
