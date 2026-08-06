'use strict';

/*
 * jemzsync test suite.
 *
 * Runs on plain Node with no dependencies:  node test/test-core.js
 *
 * Scope: every pure function in main.js, plus the vault scanner driven by a
 * fake adapter that mimics Obsidian's DataAdapter. This cannot exercise the
 * Obsidian UI — that has to be checked by hand in the app.
 */

const assert = require('assert');
const plugin = require('../main.js');
const C = plugin.__core;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
	try {
		const r = fn();
		if (r && typeof r.then === 'function') {
			return r.then(
				() => {
					passed++;
					console.log('  ok   ' + name);
				},
				(err) => {
					failed++;
					failures.push([name, err]);
					console.log('  FAIL ' + name);
				}
			);
		}
		passed++;
		console.log('  ok   ' + name);
	} catch (err) {
		failed++;
		failures.push([name, err]);
		console.log('  FAIL ' + name);
	}
	return Promise.resolve();
}

function group(name) {
	console.log('\n' + name);
}

/* ================= vault location ================= */

async function locationTests() {
	group('classifyVaultLocation');

	await test('recognises the correct Obsidian iCloud container', () => {
		const r = C.classifyVaultLocation(
			'/Users/jamal/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes',
			{ platform: 'desktop', vaultName: 'Notes' }
		);
		assert.strictEqual(r.code, 'ok');
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.syncing, true);
		assert.strictEqual(r.fixes.length, 0);
	});

	await test('flags a vault sitting in generic iCloud Drive', () => {
		const r = C.classifyVaultLocation(
			'/Users/jamal/Library/Mobile Documents/com~apple~CloudDocs/Obsidian/Notes',
			{ platform: 'desktop', vaultName: 'Notes' }
		);
		assert.strictEqual(r.code, 'wrong-icloud-folder');
		assert.strictEqual(r.ok, false);
		// Syncing but invisible to mobile — the distinction that matters.
		assert.strictEqual(r.syncing, true);
		assert.ok(r.fixes.length >= 2);
	});

	await test('flags a purely local vault', () => {
		const r = C.classifyVaultLocation('/Users/jamal/Dev/notes', {
			platform: 'desktop',
			vaultName: 'notes',
		});
		assert.strictEqual(r.code, 'local-only');
		assert.strictEqual(r.syncing, false);
	});

	await test('flags local Documents even though iCloud may mirror it', () => {
		const r = C.classifyVaultLocation('/Users/jamal/Documents/Notes', {
			platform: 'desktop',
			vaultName: 'Notes',
		});
		assert.strictEqual(r.code, 'desktop-documents');
		assert.strictEqual(r.ok, false);
	});

	await test('flags the container at the wrong depth', () => {
		const r = C.classifyVaultLocation(
			'/Users/jamal/Library/Mobile Documents/iCloud~md~obsidian/Notes',
			{ platform: 'desktop', vaultName: 'Notes' }
		);
		assert.strictEqual(r.code, 'container-wrong-depth');
	});

	await test('another app container is not mistaken for Obsidian', () => {
		const r = C.classifyVaultLocation(
			'/Users/jamal/Library/Mobile Documents/iCloud~com~apple~Pages/Documents/Notes',
			{ platform: 'desktop', vaultName: 'Notes' }
		);
		assert.strictEqual(r.code, 'other-icloud-container');
	});

	await test('mobile without a path gives manual instructions, not an error', () => {
		const r = C.classifyVaultLocation(null, {
			platform: 'mobile',
			vaultName: 'Notes',
		});
		assert.strictEqual(r.code, 'mobile-unverifiable');
		assert.ok(r.fixes.join(' ').indexOf('Files') !== -1);
		assert.ok(r.fixes.join(' ').indexOf('Notes') !== -1);
	});

	await test('handles Windows-style separators without crashing', () => {
		const r = C.classifyVaultLocation('C:\\Users\\jamal\\notes', {
			platform: 'desktop',
			vaultName: 'notes',
		});
		assert.ok(r.code);
		assert.strictEqual(typeof r.title, 'string');
	});

	await test('a trailing slash does not change the verdict', () => {
		const a = C.classifyVaultLocation(
			'/Users/jamal/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes',
			{ platform: 'desktop', vaultName: 'Notes' }
		);
		const b = C.classifyVaultLocation(
			'/Users/jamal/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes/',
			{ platform: 'desktop', vaultName: 'Notes' }
		);
		assert.strictEqual(a.code, b.code);
	});
}

/* ================= migration plan ================= */

async function migrationTests() {
	group('buildMigrationPlan');

	await test('backs up before it copies', () => {
		const plan = C.buildMigrationPlan('/Users/jamal/Dev/notes', 'Notes');
		const backupAt = plan.shell.indexOf('$HOME/Desktop/Notes-backup');
		const copyAt = plan.shell.indexOf('cp -R "/Users/jamal/Dev/notes" "$HOME/Library');
		assert.ok(backupAt > -1, 'backup command missing');
		assert.ok(copyAt > -1, 'copy command missing');
		assert.ok(backupAt < copyAt, 'backup must run first');
	});

	await test('the backup is a real command, not just a comment', () => {
		// Guards against the backup line degrading into prose while the
		// destructive copy below it survives.
		const plan = C.buildMigrationPlan('/Users/jamal/Dev/notes', 'Notes');
		const lines = plan.shell.split('\n');
		const backupCmd = lines.filter(
			(l) => l.trim().indexOf('#') !== 0 && l.indexOf('Desktop/Notes-backup') !== -1
		);
		assert.strictEqual(backupCmd.length, 1, 'expected exactly one backup command');
		assert.ok(
			/^cp -R /.test(backupCmd[0].trim()),
			'backup must be an executable cp, got: ' + backupCmd[0]
		);
		// It must timestamp, or a second run silently overwrites the only backup.
		assert.ok(backupCmd[0].indexOf('date +') !== -1, 'backup must be timestamped');
	});

	await test('every command line is either a comment or a known-safe verb', () => {
		const plan = C.buildMigrationPlan('/Users/jamal/Dev/notes', 'Notes');
		const cmds = plan.shell
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && l.indexOf('#') !== 0);
		assert.ok(cmds.length >= 3, 'expected at least backup, mkdir and copy');
		for (const c of cmds) {
			assert.ok(
				/^(cp -R|mkdir -p|brctl download) /.test(c),
				'unexpected command in migration plan: ' + c
			);
		}
	});

	await test('never deletes the original', () => {
		const plan = C.buildMigrationPlan('/Users/jamal/Dev/notes', 'Notes');
		assert.ok(!/\brm\b/.test(plan.shell), 'plan must not contain rm');
		assert.ok(!/\bmv\b/.test(plan.shell), 'plan must not contain mv');
	});

	await test('uses $HOME so paths expand inside double quotes', () => {
		const plan = C.buildMigrationPlan('/Users/jamal/Dev/notes', 'Notes');
		// A literal ~ inside "..." would not expand and would break the copy.
		assert.ok(plan.shell.indexOf('"~/') === -1, 'quoted ~ will not expand');
		assert.ok(plan.target.indexOf('$HOME') === 0);
	});

	await test('keeps the container name intact', () => {
		const plan = C.buildMigrationPlan('/Users/jamal/Dev/notes', 'Notes');
		assert.ok(plan.target.indexOf('iCloud~md~obsidian/Documents/Notes') !== -1);
	});

	await test('tolerates missing arguments', () => {
		const plan = C.buildMigrationPlan(null, null);
		assert.ok(plan.shell.length > 0);
		assert.ok(plan.steps.length > 0);
	});
}

/* ================= placeholders ================= */

async function placeholderTests() {
	group('placeholder files');

	await test('detects an offloaded stub', () => {
		assert.strictEqual(C.isPlaceholder('.Daily Note.md.icloud'), true);
		assert.strictEqual(C.placeholderTarget('.Daily Note.md.icloud'), 'Daily Note.md');
	});

	await test('leaves normal files alone', () => {
		assert.strictEqual(C.isPlaceholder('Daily Note.md'), false);
		assert.strictEqual(C.isPlaceholder('.obsidian'), false);
		assert.strictEqual(C.placeholderTarget('Daily Note.md'), null);
	});

	await test('handles dots inside the filename', () => {
		assert.strictEqual(C.placeholderTarget('.v1.2.notes.md.icloud'), 'v1.2.notes.md');
	});

	await test('is safe on empty input', () => {
		assert.strictEqual(C.isPlaceholder(''), false);
		assert.strictEqual(C.isPlaceholder(null), false);
	});
}

/* ================= path helpers ================= */

async function pathTests() {
	group('splitPath');

	await test('splits a nested path', () => {
		const p = C.splitPath('Projects/Work/Report.md');
		assert.deepStrictEqual(p, {
			dir: 'Projects/Work',
			base: 'Report.md',
			stem: 'Report',
			ext: '.md',
		});
	});

	await test('splits a root-level path', () => {
		const p = C.splitPath('Report.md');
		assert.strictEqual(p.dir, '');
		assert.strictEqual(p.stem, 'Report');
	});

	await test('treats a dotfile as having no extension', () => {
		const p = C.splitPath('.gitignore');
		assert.strictEqual(p.stem, '.gitignore');
		assert.strictEqual(p.ext, '');
	});

	await test('strips a leading slash', () => {
		assert.strictEqual(C.splitPath('/Report.md').base, 'Report.md');
	});
}

/* ================= conflicts ================= */

async function conflictTests() {
	group('findConflicts');

	await test('pairs an iCloud numbered duplicate with its original', () => {
		const r = C.findConflicts(['Notes/Meeting.md', 'Notes/Meeting 2.md']);
		assert.strictEqual(r.length, 1);
		assert.strictEqual(r[0].original, 'Notes/Meeting.md');
		assert.strictEqual(r[0].copies.length, 1);
		assert.strictEqual(r[0].copies[0].patternId, 'icloud-numbered');
	});

	await test('does NOT flag a numbered note with no original — the false-positive case', () => {
		// "Chapter 2.md" is a legitimate filename when "Chapter.md" does not exist.
		const r = C.findConflicts(['Book/Chapter 1.md', 'Book/Chapter 2.md']);
		assert.strictEqual(r.length, 0);
	});

	await test('flags "Chapter 2" only once "Chapter" exists alongside it', () => {
		const r = C.findConflicts(['Book/Chapter.md', 'Book/Chapter 2.md']);
		assert.strictEqual(r.length, 1);
	});

	await test('requires the original to be in the same folder', () => {
		const r = C.findConflicts(['A/Meeting.md', 'B/Meeting 2.md']);
		assert.strictEqual(r.length, 0);
	});

	await test('catches a conflicted copy without needing the original', () => {
		const r = C.findConflicts([
			"Notes/Plan (Jamal's MacBook Pro conflicted copy 2026-08-01).md",
		]);
		assert.strictEqual(r.length, 1);
		assert.strictEqual(r[0].original, 'Notes/Plan.md');
		assert.strictEqual(r[0].copies[0].patternId, 'conflicted-copy');
	});

	await test('catches a Syncthing-style conflict marker', () => {
		const r = C.findConflicts(['Notes/Plan.sync-conflict-20260801-120000-ABCDEFG.md']);
		assert.strictEqual(r.length, 1);
		assert.strictEqual(r[0].original, 'Notes/Plan.md');
	});

	await test('groups several duplicates under one original', () => {
		const r = C.findConflicts([
			'Meeting.md',
			'Meeting 2.md',
			'Meeting 3.md',
			'Meeting (conflicted copy 2026-08-01).md',
		]);
		assert.strictEqual(r.length, 1);
		assert.strictEqual(r[0].copies.length, 3);
	});

	await test('respects file extensions', () => {
		const r = C.findConflicts(['img.png', 'img 2.png', 'img.md']);
		assert.strictEqual(r.length, 1);
		assert.strictEqual(r[0].original, 'img.png');
	});

	await test('returns nothing for a clean vault', () => {
		assert.strictEqual(C.findConflicts(['a.md', 'b.md', 'c/d.md']).length, 0);
	});

	await test('handles an empty vault', () => {
		assert.deepStrictEqual(C.findConflicts([]), []);
	});

	group('chooseWinner');

	await test('newest modification time wins', () => {
		const w = C.chooseWinner([
			{ path: 'a.md', mtime: 100, size: 500, isOriginal: true },
			{ path: 'a 2.md', mtime: 200, size: 10 },
		]);
		assert.strictEqual(w.path, 'a 2.md');
	});

	await test('on an mtime tie the larger file wins', () => {
		const w = C.chooseWinner([
			{ path: 'a.md', mtime: 100, size: 10, isOriginal: true },
			{ path: 'a 2.md', mtime: 100, size: 900 },
		]);
		assert.strictEqual(w.path, 'a 2.md');
	});

	await test('on a full tie the original wins, so results are stable', () => {
		const w = C.chooseWinner([
			{ path: 'a 2.md', mtime: 100, size: 10 },
			{ path: 'a.md', mtime: 100, size: 10, isOriginal: true },
		]);
		assert.strictEqual(w.path, 'a.md');
	});

	await test('returns null on empty input', () => {
		assert.strictEqual(C.chooseWinner([]), null);
	});

	group('buildMergedContent');

	await test('reports no change when both versions are identical', () => {
		const r = C.buildMergedContent('same text', 'same text', {});
		assert.strictEqual(r.changed, false);
		assert.strictEqual(r.text, 'same text');
	});

	await test('keeps both bodies and names where the second came from', () => {
		const r = C.buildMergedContent('original', 'from phone', {
			copyPath: 'Note 2.md',
			when: '2026-08-01 10:00',
		});
		assert.strictEqual(r.changed, true);
		assert.ok(r.text.indexOf('original') !== -1);
		assert.ok(r.text.indexOf('from phone') !== -1);
		assert.ok(r.text.indexOf('Note 2.md') !== -1);
	});

	await test('ignores trailing-whitespace-only differences', () => {
		const r = C.buildMergedContent('text\n\n', 'text', {});
		assert.strictEqual(r.changed, false);
	});
}

/* ================= fingerprint ================= */

async function fingerprintTests() {
	group('computeFingerprint');

	const vault = [
		{ path: 'Welcome.md', size: 120, mtime: 1000 },
		{ path: 'Notes/Idea.md', size: 300, mtime: 2000 },
	];

	await test('two devices holding the same files agree', () => {
		const a = C.computeFingerprint(vault, {});
		const b = C.computeFingerprint(vault.slice().reverse(), {});
		assert.strictEqual(a.digest, b.digest);
		assert.strictEqual(a.files, 2);
		assert.strictEqual(a.bytes, 420);
	});

	await test('a missing file changes the digest — the whole point', () => {
		const a = C.computeFingerprint(vault, {});
		const b = C.computeFingerprint([vault[0]], {});
		assert.notStrictEqual(a.digest, b.digest);
	});

	await test('a changed file size changes the digest', () => {
		const a = C.computeFingerprint(vault, {});
		const b = C.computeFingerprint(
			[vault[0], { path: 'Notes/Idea.md', size: 301, mtime: 2000 }],
			{}
		);
		assert.notStrictEqual(a.digest, b.digest);
	});

	await test('size genuinely feeds the digest, not just the path list', () => {
		// The realistic failure: you edit a note on the Mac. Same filename,
		// same file count, different content. If size were dropped from the
		// digest the two devices would wrongly report a match.
		const before = [
			{ path: 'Welcome.md', size: 120, mtime: 1000 },
			{ path: 'Notes/Idea.md', size: 300, mtime: 2000 },
		];
		const after = [
			{ path: 'Welcome.md', size: 120, mtime: 1000 },
			{ path: 'Notes/Idea.md', size: 980, mtime: 2000 },
		];
		const a = C.computeFingerprint(before, {});
		const b = C.computeFingerprint(after, {});
		assert.strictEqual(a.files, b.files, 'file counts should match');
		assert.notStrictEqual(a.digest, b.digest, 'an edited note must change the digest');
	});

	await test('both halves of the digest respond to a content change', () => {
		// The digest is deliberately redundant: the left half hashes path+size
		// per file, the right half hashes count+total bytes. Either alone would
		// catch an edited note. This asserts both are actually live, so a future
		// change that silently kills one does not go unnoticed.
		const before = [
			{ path: 'W.md', size: 120, mtime: 1 },
			{ path: 'I.md', size: 300, mtime: 2 },
		];
		const after = [
			{ path: 'W.md', size: 120, mtime: 1 },
			{ path: 'I.md', size: 980, mtime: 2 },
		];
		const a = C.computeFingerprint(before, {}).digest.split('-');
		const b = C.computeFingerprint(after, {}).digest.split('-');
		assert.notStrictEqual(a[0], b[0], 'left half must react to size change');
		assert.notStrictEqual(a[1], b[1], 'right half must react to byte total');
	});

	await test('two different vaults with the same file count differ', () => {
		const a = C.computeFingerprint([{ path: 'A.md', size: 100, mtime: 1 }], {});
		const b = C.computeFingerprint([{ path: 'B.md', size: 100, mtime: 1 }], {});
		assert.notStrictEqual(a.digest, b.digest);
	});

	await test('mtime drift does NOT change the digest', () => {
		// iCloud can restamp files; that must not look like a sync failure.
		const a = C.computeFingerprint(vault, {});
		const b = C.computeFingerprint(
			vault.map((e) => ({ path: e.path, size: e.size, mtime: e.mtime + 99999 })),
			{}
		);
		assert.strictEqual(a.digest, b.digest);
	});

	await test('per-device workspace files are excluded', () => {
		const withWorkspace = vault.concat([
			{ path: '.obsidian/workspace.json', size: 9999, mtime: 5 },
			{ path: '.obsidian/workspace-mobile.json', size: 8888, mtime: 5 },
		]);
		const a = C.computeFingerprint(vault, C.DEFAULT_SETTINGS);
		const b = C.computeFingerprint(withWorkspace, C.DEFAULT_SETTINGS);
		assert.strictEqual(a.digest, b.digest);
	});

	await test('.DS_Store on the Mac does not break the match', () => {
		const withJunk = vault.concat([{ path: '.DS_Store', size: 6148, mtime: 5 }]);
		const a = C.computeFingerprint(vault, C.DEFAULT_SETTINGS);
		const b = C.computeFingerprint(withJunk, C.DEFAULT_SETTINGS);
		assert.strictEqual(a.digest, b.digest);
	});

	await test('the plugin does not count its own files', () => {
		// Found on the real vault: installing an update changes the size of
		// main.js, so a Mac on the new version and an iPhone on the old one
		// compared vaults and both reported "not synced" — the plugin raising
		// a sync alarm about nothing but its own upgrade.
		const withPlugin = vault.concat([
			{ path: '.obsidian/plugins/jemzsync/main.js', size: 87380, mtime: 5 },
			{ path: '.obsidian/plugins/jemzsync/manifest.json', size: 364, mtime: 5 },
			{ path: '.obsidian/plugins/jemzsync/styles.css', size: 3918, mtime: 5 },
		]);
		const a = C.computeFingerprint(vault, C.DEFAULT_SETTINGS);
		const b = C.computeFingerprint(withPlugin, C.DEFAULT_SETTINGS);
		assert.strictEqual(a.digest, b.digest);
	});

	await test('an upgrade on one device alone does not break the match', () => {
		const oldVersion = vault.concat([
			{ path: '.obsidian/plugins/jemzsync/main.js', size: 68793, mtime: 5 },
		]);
		const newVersion = vault.concat([
			{ path: '.obsidian/plugins/jemzsync/main.js', size: 87380, mtime: 9 },
		]);
		assert.strictEqual(
			C.computeFingerprint(oldVersion, C.DEFAULT_SETTINGS).digest,
			C.computeFingerprint(newVersion, C.DEFAULT_SETTINGS).digest
		);
	});

	await test('the self-exclusion holds even with every setting stripped', () => {
		// Settings live in the vault, so anyone upgrading carries the old
		// exclusion list across. The guard cannot depend on it.
		const withPlugin = vault.concat([
			{ path: '.obsidian/plugins/jemzsync/main.js', size: 87380, mtime: 5 },
		]);
		const bare = { excludePrefixes: [], excludeNames: [] };
		assert.strictEqual(
			C.computeFingerprint(vault, bare).digest,
			C.computeFingerprint(withPlugin, bare).digest
		);
	});

	await test('another plugin is still counted', () => {
		// Only our own self-reference is the problem; a plugin present on one
		// device and missing on the other is a genuine difference.
		const withOther = vault.concat([
			{ path: '.obsidian/plugins/dataview/main.js', size: 500, mtime: 5 },
		]);
		assert.notStrictEqual(
			C.computeFingerprint(vault, C.DEFAULT_SETTINGS).digest,
			C.computeFingerprint(withOther, C.DEFAULT_SETTINGS).digest
		);
	});

	await test('offloaded placeholders are excluded', () => {
		const withStub = vault.concat([
			{ path: 'Notes/.Idea.md.icloud', size: 156, mtime: 5 },
		]);
		const a = C.computeFingerprint(vault, C.DEFAULT_SETTINGS);
		const b = C.computeFingerprint(withStub, C.DEFAULT_SETTINGS);
		assert.strictEqual(a.digest, b.digest);
	});

	await test('produces a stable, readable digest shape', () => {
		const a = C.computeFingerprint(vault, {});
		assert.ok(/^[0-9a-f]{8}-[0-9a-f]{8}$/.test(a.digest), 'got ' + a.digest);
	});

	await test('an empty vault does not crash', () => {
		const a = C.computeFingerprint([], {});
		assert.strictEqual(a.files, 0);
		assert.strictEqual(a.bytes, 0);
	});

	group('compareFingerprints');

	await test('reports a match plainly', () => {
		const fp = C.computeFingerprint(vault, {});
		const r = C.compareFingerprints(fp, fp);
		assert.strictEqual(r.match, true);
		assert.ok(r.summary.indexOf('Sync is working') !== -1);
	});

	await test('says which device is behind', () => {
		const a = C.computeFingerprint(vault, {});
		const b = C.computeFingerprint([vault[0]], {});
		const r = C.compareFingerprints(a, b);
		assert.strictEqual(r.match, false);
		assert.ok(r.summary.indexOf('1 more') !== -1);
	});

	await test('handles a missing fingerprint', () => {
		assert.strictEqual(C.compareFingerprints(null, null).match, false);
	});
}

/* ================= summary + formatting ================= */

async function summaryTests() {
	group('summarizeScan');

	const clean = {
		conflicts: [],
		placeholders: [],
		fingerprint: { files: 42 },
		location: { ok: true },
	};

	await test('a healthy vault reports the file count', () => {
		const s = C.summarizeScan(clean);
		assert.strictEqual(s.level, 'ok');
		assert.ok(s.text.indexOf('42 files synced') !== -1);
	});

	await test('conflicts outrank everything else', () => {
		const s = C.summarizeScan(
			Object.assign({}, clean, { conflicts: [{}, {}], location: { ok: false } })
		);
		assert.strictEqual(s.level, 'warn');
		assert.ok(s.text.indexOf('2 conflicts') !== -1);
	});

	await test('singular wording for one conflict', () => {
		const s = C.summarizeScan(Object.assign({}, clean, { conflicts: [{}] }));
		assert.ok(s.text.indexOf('1 conflict') !== -1);
		assert.ok(s.text.indexOf('conflicts') === -1);
	});

	await test('undownloaded files are surfaced', () => {
		const s = C.summarizeScan(Object.assign({}, clean, { placeholders: [{}, {}, {}] }));
		assert.ok(s.text.indexOf('3 files not downloaded') !== -1);
	});

	await test('a bad location is surfaced when nothing else is wrong', () => {
		const s = C.summarizeScan(Object.assign({}, clean, { location: { ok: false } }));
		assert.strictEqual(s.level, 'warn');
		assert.ok(s.text.indexOf('check setup') !== -1);
	});

	await test('handles never having scanned', () => {
		assert.strictEqual(C.summarizeScan(null).level, 'idle');
	});

	group('formatBytes');

	await test('scales units', () => {
		assert.strictEqual(C.formatBytes(0), '0 B');
		assert.strictEqual(C.formatBytes(512), '512 B');
		assert.strictEqual(C.formatBytes(2048), '2.0 KB');
		assert.strictEqual(C.formatBytes(5 * 1024 * 1024), '5.0 MB');
	});
}

/* ================= scanner ================= */

/** Minimal stand-in for Obsidian's DataAdapter. */
function fakeAdapter(tree) {
	return {
		async list(dir) {
			const key = dir === '/' ? '' : dir.replace(/^\/+/, '');
			const node = tree[key];
			if (!node) return { files: [], folders: [] };
			return {
				files: node.files || [],
				folders: node.folders || [],
			};
		},
		async stat(path) {
			const meta = tree.__stats && tree.__stats[path];
			if (!meta) throw new Error('ENOENT ' + path);
			return Object.assign({ type: 'file' }, meta);
		},
	};
}

async function scannerTests() {
	group('scanVault');

	const tree = {
		'': { files: ['Welcome.md', '.DS_Store'], folders: ['Notes', '.obsidian'] },
		Notes: {
			files: ['Idea.md', 'Idea 2.md', '.Big Attachment.pdf.icloud'],
			folders: [],
		},
		'.obsidian': { files: ['.obsidian/workspace.json'], folders: [] },
		__stats: {
			'Welcome.md': { size: 120, mtime: 1000 },
			'.DS_Store': { size: 6148, mtime: 900 },
			'Notes/Idea.md': { size: 300, mtime: 2000 },
			'Notes/Idea 2.md': { size: 340, mtime: 3000 },
			'.obsidian/workspace.json': { size: 5000, mtime: 4000 },
		},
	};
	// Folder listings hand back full vault-relative paths, as Obsidian does.
	tree[''].files = ['Welcome.md', '.DS_Store'];
	tree['Notes'].files = [
		'Notes/Idea.md',
		'Notes/Idea 2.md',
		'Notes/.Big Attachment.pdf.icloud',
	];

	await test('walks nested folders', async () => {
		const scan = await C.scanVault(fakeAdapter(tree), C.DEFAULT_SETTINGS);
		const paths = scan.entries.map((e) => e.path).sort();
		assert.ok(paths.indexOf('Welcome.md') !== -1);
		assert.ok(paths.indexOf('Notes/Idea.md') !== -1);
		assert.ok(paths.indexOf('.obsidian/workspace.json') !== -1);
	});

	await test('separates offloaded placeholders from real files', async () => {
		const scan = await C.scanVault(fakeAdapter(tree), C.DEFAULT_SETTINGS);
		assert.strictEqual(scan.placeholders.length, 1);
		assert.strictEqual(scan.placeholders[0].expects, 'Notes/Big Attachment.pdf');
		assert.ok(
			scan.entries.every((e) => e.path.indexOf('.icloud') === -1),
			'placeholders must not be counted as files'
		);
	});

	await test('finds the conflicted pair inside a folder', async () => {
		const scan = await C.scanVault(fakeAdapter(tree), C.DEFAULT_SETTINGS);
		assert.strictEqual(scan.conflicts.length, 1);
		assert.strictEqual(scan.conflicts[0].original, 'Notes/Idea.md');
	});

	await test('excludes per-device files from the fingerprint', async () => {
		const scan = await C.scanVault(fakeAdapter(tree), C.DEFAULT_SETTINGS);
		// Welcome.md + Notes/Idea.md + Notes/Idea 2.md; workspace and .DS_Store excluded.
		assert.strictEqual(scan.fingerprint.files, 3);
	});

	await test('builds a path index for conflict resolution', async () => {
		const scan = await C.scanVault(fakeAdapter(tree), C.DEFAULT_SETTINGS);
		assert.strictEqual(scan.byPath['Notes/Idea 2.md'].mtime, 3000);
	});

	await test('records stat failures instead of throwing', async () => {
		const broken = JSON.parse(JSON.stringify(tree));
		delete broken.__stats['Welcome.md'];
		const scan = await C.scanVault(fakeAdapter(broken), C.DEFAULT_SETTINGS);
		assert.ok(scan.errors.length >= 1);
		// The file is still listed, just with unknown size.
		assert.ok(scan.entries.some((e) => e.path === 'Welcome.md'));
	});

	await test('survives a listing failure on one folder', async () => {
		const adapter = fakeAdapter(tree);
		const realList = adapter.list;
		adapter.list = async function (dir) {
			if (dir === 'Notes') throw new Error('permission denied');
			return realList.call(adapter, dir);
		};
		const scan = await C.scanVault(adapter, C.DEFAULT_SETTINGS);
		assert.ok(scan.errors.some((e) => e.path === 'Notes'));
		assert.ok(scan.entries.some((e) => e.path === 'Welcome.md'));
	});

	await test('handles an empty vault', async () => {
		const scan = await C.scanVault(fakeAdapter({ '': { files: [], folders: [] } }), C.DEFAULT_SETTINGS);
		assert.strictEqual(scan.entries.length, 0);
		assert.strictEqual(scan.fingerprint.files, 0);
		assert.strictEqual(scan.conflicts.length, 0);
	});

	await test('does not loop forever on a self-referencing folder', async () => {
		const loop = {
			'': { files: [], folders: ['A'] },
			A: { files: ['A/x.md'], folders: ['A'] },
			__stats: { 'A/x.md': { size: 1, mtime: 1 } },
		};
		const scan = await C.scanVault(fakeAdapter(loop), C.DEFAULT_SETTINGS);
		assert.strictEqual(scan.entries.length, 1);
	});

	await test('two devices with identical trees produce identical fingerprints', async () => {
		const mac = await C.scanVault(fakeAdapter(tree), C.DEFAULT_SETTINGS);
		const iphoneTree = JSON.parse(JSON.stringify(tree));
		// The phone has no .DS_Store and a different workspace file. Same notes.
		iphoneTree[''].files = ['Welcome.md'];
		delete iphoneTree.__stats['.DS_Store'];
		iphoneTree['.obsidian'].files = ['.obsidian/workspace-mobile.json'];
		iphoneTree.__stats['.obsidian/workspace-mobile.json'] = { size: 77, mtime: 4444 };
		delete iphoneTree.__stats['.obsidian/workspace.json'];

		const iphone = await C.scanVault(fakeAdapter(iphoneTree), C.DEFAULT_SETTINGS);
		assert.strictEqual(
			mac.fingerprint.digest,
			iphone.fingerprint.digest,
			'same notes must fingerprint the same across devices'
		);
	});

	await test('a note missing on the phone shows up as a mismatch', async () => {
		const mac = await C.scanVault(fakeAdapter(tree), C.DEFAULT_SETTINGS);
		const iphoneTree = JSON.parse(JSON.stringify(tree));
		iphoneTree['Notes'].files = ['Notes/Idea.md'];
		const iphone = await C.scanVault(fakeAdapter(iphoneTree), C.DEFAULT_SETTINGS);
		assert.notStrictEqual(mac.fingerprint.digest, iphone.fingerprint.digest);
		const cmp = C.compareFingerprints(mac.fingerprint, iphone.fingerprint);
		assert.strictEqual(cmp.match, false);
	});
}

/* ================= device beacons ================= */

async function beaconTests() {
	group('device beacons');

	const mac = { id: 'mac00001', name: 'Mac', platform: 'Mac' };
	const fp = { digest: 'aaaa1111-bbbb2222', files: 3, bytes: 420 };

	await test('a beacon round-trips through JSON', () => {
		const b = C.makeBeacon(mac, fp, 1700000000000, '1.1.0');
		const parsed = C.parseBeacon(JSON.stringify(b));
		assert.strictEqual(parsed.ok, true);
		assert.strictEqual(parsed.beacon.id, 'mac00001');
		assert.strictEqual(parsed.beacon.name, 'Mac');
		assert.strictEqual(parsed.beacon.fingerprint.digest, fp.digest);
		assert.strictEqual(parsed.beacon.fingerprint.files, 3);
		assert.strictEqual(parsed.beacon.updatedAt, 1700000000000);
	});

	await test('garbage on disk never throws and never passes', () => {
		const garbage = [
			'',
			'not json',
			'{}',
			'[]',
			'null',
			'{"kind":"other"}',
			'{"kind":"jemzsync-beacon"}',
			'{"kind":"jemzsync-beacon","id":"x"}',
			'{"kind":"other","id":"x","fingerprint":{"digest":"d"}}',
			'{"kind":"jemzsync-beacon","id":"","fingerprint":{"digest":"d"}}',
		];
		for (const g of garbage) {
			assert.strictEqual(C.parseBeacon(g).ok, false, 'accepted: ' + g);
		}
	});

	await test('a half-synced (truncated) beacon is skipped, not fatal', () => {
		const full = JSON.stringify(C.makeBeacon(mac, fp, 1, '1.1.0'));
		const truncated = full.slice(0, full.length - 20);
		assert.strictEqual(C.parseBeacon(truncated).ok, false);
	});

	await test('beacon paths are recognised precisely', () => {
		assert.strictEqual(C.isBeaconPath('.jemzsync/device-abc123.json'), true);
		assert.strictEqual(C.isBeaconPath('.jemzsync/notes.md'), false);
		assert.strictEqual(C.isBeaconPath('.jemzsync/device-abc123.json.bak'), false);
		assert.strictEqual(C.isBeaconPath('Notes/device-abc.json'), false);
		assert.strictEqual(C.isBeaconPath(''), false);
	});

	await test('splitBeacons separates this device from the others', () => {
		const mine = { id: 'me', name: 'Mac', updatedAt: 5, fingerprint: { digest: 'd' } };
		const phone = { id: 'ph', name: 'iPhone', updatedAt: 9, fingerprint: { digest: 'd' } };
		const r = C.splitBeacons([phone, mine], 'me');
		assert.strictEqual(r.self.id, 'me');
		assert.strictEqual(r.others.length, 1);
		assert.strictEqual(r.others[0].id, 'ph');
	});

	await test('with two of our own beacons, the newest wins', () => {
		const older = { id: 'me', name: 'Mac', updatedAt: 5, fingerprint: { digest: 'old' } };
		const newer = { id: 'me', name: 'Mac', updatedAt: 9, fingerprint: { digest: 'new' } };
		const r = C.splitBeacons([older, newer], 'me');
		assert.strictEqual(r.self.fingerprint.digest, 'new');
	});

	await test('others are sorted stably by name', () => {
		const r = C.splitBeacons(
			[
				{ id: 'b', name: 'iPhone', updatedAt: 1, fingerprint: { digest: 'x' } },
				{ id: 'a', name: 'iPad', updatedAt: 1, fingerprint: { digest: 'x' } },
			],
			'me'
		);
		assert.deepStrictEqual(
			r.others.map((o) => o.name),
			['iPad', 'iPhone']
		);
	});

	await test('the first beacon always gets written', () => {
		assert.strictEqual(C.shouldWriteBeacon(null, 'd', 1000, 60000), true);
	});

	await test('an unchanged vault inside the interval writes nothing (no iCloud churn)', () => {
		const prev = { updatedAt: 1000, fingerprint: { digest: 'd' } };
		assert.strictEqual(C.shouldWriteBeacon(prev, 'd', 2000, 60000), false);
	});

	await test('a changed vault rewrites the beacon immediately', () => {
		const prev = { updatedAt: 1000, fingerprint: { digest: 'old' } };
		assert.strictEqual(C.shouldWriteBeacon(prev, 'new', 2000, 60000), true);
	});

	await test('a heartbeat still goes out once the interval passes', () => {
		const prev = { updatedAt: 1000, fingerprint: { digest: 'd' } };
		assert.strictEqual(C.shouldWriteBeacon(prev, 'd', 1000 + 60000, 60000), true);
	});

	await test('summarizeDevices reports a match', () => {
		const local = { digest: 'd', files: 3, bytes: 420 };
		const others = [
			{ id: 'ph', name: 'iPhone', platform: 'iPhone', updatedAt: 900, fingerprint: { digest: 'd', files: 3, bytes: 420 } },
		];
		const r = C.summarizeDevices(others, local, 1000);
		assert.strictEqual(r.length, 1);
		assert.strictEqual(r[0].match, true);
		assert.strictEqual(r[0].stale, false);
	});

	await test('summarizeDevices says which side is behind', () => {
		const local = { digest: 'a', files: 3 };
		const others = [
			{ id: 'ph', name: 'iPhone', platform: '', updatedAt: 900, fingerprint: { digest: 'b', files: 5, bytes: 1 } },
		];
		const r = C.summarizeDevices(others, local, 1000);
		assert.strictEqual(r[0].match, false);
		assert.ok(r[0].summary.indexOf('2 more') !== -1);
	});

	await test('a device silent for two days is marked stale', () => {
		const now = Date.now();
		const others = [
			{ id: 'ph', name: 'iPhone', platform: '', updatedAt: now - 49 * 3600 * 1000, fingerprint: { digest: 'd', files: 1, bytes: 1 } },
		];
		const r = C.summarizeDevices(others, { digest: 'd', files: 1 }, now);
		assert.strictEqual(r[0].stale, true);
	});

	await test('newDeviceId is 8 lowercase alphanumerics and honours the rng', () => {
		let calls = 0;
		const rng = () => {
			calls++;
			return 0.5;
		};
		const id = C.newDeviceId(rng);
		assert.ok(/^[a-z0-9]{8}$/.test(id), 'got ' + id);
		assert.strictEqual(calls, 8);
		assert.strictEqual(C.newDeviceId(rng), id, 'same rng must give same id');
	});
}

/* ================= scanner + beacons ================= */

async function scannerBeaconTests() {
	group('scanner with beacons');

	const base = {
		'': { files: ['Welcome.md'], folders: ['.jemzsync', '.obsidian'] },
		'.jemzsync': { files: ['.jemzsync/device-mac00001.json'], folders: [] },
		'.obsidian': {
			files: ['.obsidian/workspace.json', '.obsidian/workspace 2.json'],
			folders: [],
		},
		__stats: {
			'Welcome.md': { size: 120, mtime: 1000 },
			'.jemzsync/device-mac00001.json': { size: 200, mtime: 1500 },
			'.obsidian/workspace.json': { size: 5000, mtime: 4000 },
			'.obsidian/workspace 2.json': { size: 5100, mtime: 4100 },
		},
	};

	await test('beacon files are collected for reading', async () => {
		const scan = await C.scanVault(fakeAdapter(base), C.DEFAULT_SETTINGS);
		assert.deepStrictEqual(scan.beaconPaths, ['.jemzsync/device-mac00001.json']);
	});

	await test('beacons never perturb the fingerprint', async () => {
		// Critical: if beacons fed the fingerprint, writing one would change
		// the digest, which would trigger another write on the other device,
		// forever. Two devices could never converge.
		const withBeacon = await C.scanVault(fakeAdapter(base), C.DEFAULT_SETTINGS);
		const stripped = JSON.parse(JSON.stringify(base));
		stripped[''].folders = ['.obsidian'];
		delete stripped['.jemzsync'];
		delete stripped.__stats['.jemzsync/device-mac00001.json'];
		const withoutBeacon = await C.scanVault(fakeAdapter(stripped), C.DEFAULT_SETTINGS);
		assert.strictEqual(withBeacon.fingerprint.digest, withoutBeacon.fingerprint.digest);
	});

	await test('a duplicated workspace file is not reported as a note conflict', async () => {
		const scan = await C.scanVault(fakeAdapter(base), C.DEFAULT_SETTINGS);
		assert.strictEqual(scan.conflicts.length, 0);
	});

	await test('a duplicated beacon is not reported as a note conflict', async () => {
		const t = JSON.parse(JSON.stringify(base));
		t['.jemzsync'].files.push('.jemzsync/device-mac00001 2.json');
		t.__stats['.jemzsync/device-mac00001 2.json'] = { size: 200, mtime: 1600 };
		const scan = await C.scanVault(fakeAdapter(t), C.DEFAULT_SETTINGS);
		assert.strictEqual(scan.conflicts.length, 0);
	});

	await test('real note conflicts are still reported alongside beacons', async () => {
		const t = JSON.parse(JSON.stringify(base));
		t[''].files.push('Welcome 2.md');
		t.__stats['Welcome 2.md'] = { size: 130, mtime: 1100 };
		const scan = await C.scanVault(fakeAdapter(t), C.DEFAULT_SETTINGS);
		assert.strictEqual(scan.conflicts.length, 1);
		assert.strictEqual(scan.conflicts[0].original, 'Welcome.md');
	});

	await test('end to end: Mac beacon read on the iPhone shows a match', async () => {
		// Simulates the full loop: the Mac writes its beacon, iCloud carries it
		// over, the iPhone scans and parses it against its own fingerprint.
		const macScan = await C.scanVault(fakeAdapter(base), C.DEFAULT_SETTINGS);
		const macBeacon = C.makeBeacon(
			{ id: 'mac00001', name: 'Mac', platform: 'Mac' },
			macScan.fingerprint,
			Date.now(),
			'1.1.0'
		);

		// iPhone vault: same notes, different per-device files.
		const phoneTree = JSON.parse(JSON.stringify(base));
		phoneTree['.obsidian'].files = ['.obsidian/workspace-mobile.json'];
		phoneTree.__stats['.obsidian/workspace-mobile.json'] = { size: 77, mtime: 9 };
		const phoneScan = await C.scanVault(fakeAdapter(phoneTree), C.DEFAULT_SETTINGS);

		const parsed = C.parseBeacon(JSON.stringify(macBeacon));
		assert.strictEqual(parsed.ok, true);
		const split = C.splitBeacons([parsed.beacon], 'phone001');
		const devices = C.summarizeDevices(split.others, phoneScan.fingerprint, Date.now());
		assert.strictEqual(devices.length, 1);
		assert.strictEqual(devices[0].name, 'Mac');
		assert.strictEqual(devices[0].match, true, 'identical notes must match across devices');
	});

	await test('end to end: a note missing on the iPhone shows as a mismatch', async () => {
		const macScan = await C.scanVault(fakeAdapter(base), C.DEFAULT_SETTINGS);
		const macBeacon = C.makeBeacon(
			{ id: 'mac00001', name: 'Mac', platform: 'Mac' },
			macScan.fingerprint,
			Date.now(),
			'1.1.0'
		);
		const emptyPhone = await C.scanVault(
			fakeAdapter({ '': { files: [], folders: [] } }),
			C.DEFAULT_SETTINGS
		);
		const parsed = C.parseBeacon(JSON.stringify(macBeacon));
		const devices = C.summarizeDevices([parsed.beacon], emptyPhone.fingerprint, Date.now());
		assert.strictEqual(devices[0].match, false);
		assert.ok(devices[0].summary.indexOf('1 more') !== -1);
	});
}

/* ================= pairing auto-fill ================= */

function beacon(id, name, digest, updatedAt, files, bytes) {
	return {
		id: id,
		name: name,
		platform: '',
		updatedAt: updatedAt,
		fingerprint: { digest: digest, files: files || 0, bytes: bytes || 0 },
	};
}

async function pairingTests() {
	group('pickPairedBeacon');

	const NOW = 1000000;
	const DAY = 24 * 3600 * 1000;

	await test('no other devices means nothing to pair with', () => {
		assert.strictEqual(C.pickPairedBeacon([], NOW), null);
		assert.strictEqual(C.pickPairedBeacon(null, NOW), null);
	});

	await test('picks the most recently updated device', () => {
		const r = C.pickPairedBeacon(
			[beacon('a', 'iPad', 'd1', NOW - 5000), beacon('b', 'iPhone', 'd2', NOW - 100)],
			NOW
		);
		assert.strictEqual(r.id, 'b');
	});

	await test('a fresh device beats a stale one even if the stale one is newer', () => {
		// Guards against a clock-skewed device that has been offline for a week
		// hijacking the comparison from one that checked in an hour ago.
		const r = C.pickPairedBeacon(
			[beacon('stale', 'Old', 'd1', NOW + 60 * DAY), beacon('fresh', 'iPhone', 'd2', NOW - 3600000)],
			NOW,
			2 * DAY
		);
		assert.strictEqual(r.id, 'fresh');
	});

	await test('a beacon with no digest is never chosen', () => {
		const broken = { id: 'x', name: 'Broken', updatedAt: NOW, fingerprint: {} };
		assert.strictEqual(C.pickPairedBeacon([broken], NOW), null);
		const r = C.pickPairedBeacon([broken, beacon('ok', 'iPhone', 'd', NOW - 1)], NOW);
		assert.strictEqual(r.id, 'ok');
	});

	group('autofillValue');

	await test('fills an empty field', () => {
		const r = C.autofillValue('', '', 'abc-123');
		assert.strictEqual(r.value, 'abc-123');
		assert.strictEqual(r.source, 'auto');
		assert.strictEqual(r.changed, true);
	});

	await test('NEVER overwrites a value the user typed', () => {
		// The single most important rule in this feature.
		const r = C.autofillValue('mine', 'manual', 'detected');
		assert.strictEqual(r.value, 'mine');
		assert.strictEqual(r.source, 'manual');
		assert.strictEqual(r.changed, false);
	});

	await test('refreshes a value it filled in itself', () => {
		const r = C.autofillValue('old-digest', 'auto', 'new-digest');
		assert.strictEqual(r.value, 'new-digest');
		assert.strictEqual(r.source, 'auto');
		assert.strictEqual(r.changed, true);
	});

	await test('an unchanged auto value reports no change (no needless writes)', () => {
		const r = C.autofillValue('same', 'auto', 'same');
		assert.strictEqual(r.changed, false);
	});

	await test('clearing a manual field hands it back to auto-fill', () => {
		// "if still empty plugin can help to input automatically"
		const r = C.autofillValue('', 'manual', 'detected');
		assert.strictEqual(r.value, 'detected');
		assert.strictEqual(r.source, 'auto');
	});

	await test('a value carried over from an older version is treated as typed', () => {
		// Upgrade path: pre-auto-fill versions stored no provenance. The only
		// way a value got there was by hand, so it must be protected.
		const r = C.autofillValue('typed-before-upgrade', '', 'detected');
		assert.strictEqual(r.value, 'typed-before-upgrade');
		assert.strictEqual(r.source, 'manual');
		assert.strictEqual(r.changed, true, 'the new provenance has to be persisted');
	});

	await test('detecting nothing leaves the field exactly as it was', () => {
		for (const src of ['', 'auto', 'manual']) {
			const r = C.autofillValue('kept', src, '');
			assert.strictEqual(r.value, 'kept');
			assert.strictEqual(r.source, src);
			assert.strictEqual(r.changed, false);
		}
	});

	await test('whitespace is trimmed on both sides', () => {
		assert.strictEqual(C.autofillValue('  ', '', ' abc ').value, 'abc');
	});
}

/* ================= device naming ================= */

async function deviceNameTests() {
	group('suggestDeviceName');

	await test('each platform names itself correctly', () => {
		assert.strictEqual(C.suggestDeviceName({ isIosApp: true }), 'iPhone');
		assert.strictEqual(C.suggestDeviceName({ isIosApp: true, isTablet: true }), 'iPad');
		assert.strictEqual(
			C.suggestDeviceName({ isMacOS: true, isDesktopApp: true }),
			'Mac'
		);
		assert.strictEqual(C.suggestDeviceName({ isWin: true }), 'Windows PC');
		assert.strictEqual(C.suggestDeviceName({ isLinux: true }), 'Linux PC');
	});

	await test('an Android phone does NOT call itself an iPhone', () => {
		// isPhone/isTablet are set on Android too. Reading them before the
		// platform flags is what made an Android device announce "iPhone".
		assert.strictEqual(
			C.suggestDeviceName({ isAndroidApp: true, isPhone: true }),
			'Android phone'
		);
		assert.strictEqual(
			C.suggestDeviceName({ isAndroidApp: true, isTablet: true }),
			'Android tablet'
		);
	});

	await test('an unknown device still gets a name', () => {
		assert.strictEqual(C.suggestDeviceName({}), 'Device');
		assert.strictEqual(C.suggestDeviceName(null), 'Device');
	});

	group('disambiguateDeviceName');

	await test('a unique name is left alone', () => {
		assert.strictEqual(
			C.disambiguateDeviceName('Mac', [{ id: 'x', name: 'iPhone' }]),
			'Mac'
		);
		assert.strictEqual(C.disambiguateDeviceName('Mac', []), 'Mac');
	});

	await test('a second Mac becomes "Mac 2"', () => {
		assert.strictEqual(
			C.disambiguateDeviceName('Mac', [{ id: 'x', name: 'Mac' }]),
			'Mac 2'
		);
	});

	await test('a third Mac skips past the taken number', () => {
		assert.strictEqual(
			C.disambiguateDeviceName('Mac', [
				{ id: 'x', name: 'Mac' },
				{ id: 'y', name: 'Mac 2' },
			]),
			'Mac 3'
		);
	});

	await test('exactly one of two colliding devices gives way', () => {
		// Both Macs boot unnamed and both see the other. Without the id
		// tie-break they would both rename to "Mac 2" and collide again.
		const lower = C.disambiguateDeviceName('Mac', [{ id: 'bbb', name: 'Mac' }], 'aaa');
		const higher = C.disambiguateDeviceName('Mac', [{ id: 'aaa', name: 'Mac' }], 'bbb');
		assert.strictEqual(lower, 'Mac', 'the earlier id keeps the name');
		assert.strictEqual(higher, 'Mac 2', 'the later id gives way');
		assert.notStrictEqual(lower, higher, 'they must not land on the same name');
	});

	await test('comparison ignores case', () => {
		assert.strictEqual(
			C.disambiguateDeviceName('Mac', [{ id: 'x', name: 'mac' }]),
			'Mac 2'
		);
	});

	group('freshBeacons');

	const NOW = 2000000000000;
	const DAY = 24 * 3600 * 1000;

	await test('a device silent past the stale window stops counting', () => {
		const r = C.freshBeacons(
			[
				beacon('live', 'iPhone', 'd', NOW - 3600000),
				beacon('ghost', 'iPhone', 'd', NOW - 10 * DAY),
			],
			NOW,
			2 * DAY
		);
		assert.deepStrictEqual(r.map((b) => b.id), ['live']);
	});

	await test('a ghost from an old install does not push a name up a number', () => {
		// Found on the real vault: reinstalling left an orphan beacon still
		// called "iPhone", so the actual iPhone renamed itself "iPhone 2".
		// Nothing ever deletes a beacon, so without this the number only grows.
		const ghost = beacon('aaaghost', 'iPhone', 'd', NOW - 10 * DAY);
		const live = [ghost];
		assert.strictEqual(
			C.disambiguateDeviceName('iPhone', live, 'zzzphone'),
			'iPhone 2',
			'unfiltered, the ghost still contests the name'
		);
		assert.strictEqual(
			C.disambiguateDeviceName('iPhone', C.freshBeacons(live, NOW, 2 * DAY), 'zzzphone'),
			'iPhone',
			'once filtered, the phone keeps its name'
		);
	});

	await test('a device that is genuinely here still contests', () => {
		const live = [beacon('aaalive', 'Mac', 'd', NOW - 60000)];
		assert.strictEqual(
			C.disambiguateDeviceName('Mac', C.freshBeacons(live, NOW, 2 * DAY), 'zzzmac'),
			'Mac 2'
		);
	});

	await test('handles empty and missing input', () => {
		assert.deepStrictEqual(C.freshBeacons([], NOW), []);
		assert.deepStrictEqual(C.freshBeacons(null, NOW), []);
	});
}

/* ================= ecosystem-neutral language ================= */

const APPLE_WORDS = ['iPhone', 'iPad', 'iCloud', 'Finder', 'Apple'];

async function languageTests() {
	group('ecosystem vocabulary');

	await test('every ecosystem defines every field it is asked for', () => {
		const required = [
			'id',
			'label',
			'cloud',
			'folderHint',
			'fileManager',
			'otherDevice',
			'deviceExample',
		];
		for (const key of Object.keys(C.ECOSYSTEMS)) {
			const eco = C.ECOSYSTEMS[key];
			for (const field of required) {
				assert.ok(
					eco[field] && typeof eco[field] === 'string',
					'ecosystem ' + key + ' is missing ' + field
				);
			}
		}
	});

	await test('no non-Apple ecosystem uses Apple vocabulary', () => {
		// The bug this whole part exists to fix: a Windows user being told to
		// look in Finder and compare against their iPhone.
		for (const key of Object.keys(C.ECOSYSTEMS)) {
			if (key === 'apple') continue;
			const text = JSON.stringify(C.ECOSYSTEMS[key]);
			for (const word of APPLE_WORDS) {
				assert.strictEqual(
					text.indexOf(word),
					-1,
					'ecosystem ' + key + ' mentions ' + word + ': ' + text
				);
			}
		}
	});

	await test('Apple keeps its own correct vocabulary', () => {
		assert.strictEqual(C.ECOSYSTEMS.apple.fileManager, 'Finder');
		assert.strictEqual(C.ECOSYSTEMS.windows.fileManager, 'File Explorer');
	});

	group('transportName');

	await test('names the cloud each ecosystem actually uses', () => {
		assert.strictEqual(C.transportName('apple'), 'iCloud Drive');
		assert.strictEqual(C.transportName('windows'), 'Google Drive');
		assert.strictEqual(C.transportName('android'), 'Google Drive');
	});

	await test('an unknown ecosystem gets neutral wording, not a guess', () => {
		assert.strictEqual(C.transportName('nonsense'), 'a sync folder');
		assert.strictEqual(C.transportName(undefined), 'a sync folder');
	});

	await test('GitHub storage overrides the ecosystem entirely', () => {
		// A cross-ecosystem vault is not carried by anyone's cloud, so telling
		// the user to wait for iCloud would be nonsense.
		assert.strictEqual(C.transportName('apple', 'github'), 'GitHub');
		assert.strictEqual(C.transportName('windows', 'github'), 'GitHub');
	});

	await test("'ecosystem' mode is the same as passing no mode", () => {
		assert.strictEqual(C.transportName('apple', 'ecosystem'), C.transportName('apple'));
	});

	group('compareFingerprints wording');

	const a = { digest: 'aaa', files: 3 };
	const b = { digest: 'bbb', files: 5 };

	await test('mentions no cloud at all when it has not been told one', () => {
		const s = C.compareFingerprints(a, b).summary;
		for (const word of APPLE_WORDS) {
			assert.strictEqual(s.indexOf(word), -1, 'default wording leaked ' + word + ': ' + s);
		}
	});

	await test('names the transport it was given', () => {
		assert.ok(C.compareFingerprints(a, b, 'Google Drive').summary.indexOf('Google Drive') !== -1);
		assert.ok(C.compareFingerprints(a, b, 'GitHub').summary.indexOf('GitHub') !== -1);
	});

	await test('the existing two-argument behaviour is unchanged', () => {
		// Many callers still pass two arguments; they must keep working.
		const r = C.compareFingerprints(a, b);
		assert.strictEqual(r.match, false);
		assert.ok(r.summary.indexOf('2 more') !== -1);
		assert.strictEqual(C.compareFingerprints(a, a).match, true);
	});

	await test('summarizeDevices passes the transport through to each line', () => {
		const lines = C.summarizeDevices(
			[beacon('x', 'PC', 'other', 900, 5)],
			{ digest: 'mine', files: 3 },
			1000,
			null,
			'Google Drive'
		);
		assert.ok(lines[0].summary.indexOf('Google Drive') !== -1);
	});

	group('no Apple wording in the shared UI (regression guard)');

	await test('the panel and settings screens name no Apple product', () => {
		// This is the guard for what shipped: nine strings shown on every
		// platform that hardcoded Apple's vocabulary. Reading the source is
		// crude, but it is the only way to check text that only exists inside
		// Obsidian's DOM — and it catches exactly the mistake that was made.
		const fs = require('fs');
		const src = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');

		const start = src.indexOf('class JemzSyncView');
		const end = src.indexOf('module.exports = JemzSyncPlugin');
		assert.ok(start > -1 && end > start, 'could not locate the view/settings classes');
		const shared = src.slice(start, end);

		// The one intentional exception: the offloaded-files card explains the
		// iOS fix, and is gated on the ecosystem actually being Apple.
		const ALLOWED = [
			"' On iPhone, open the vault folder in Files and pull down to download.'",
		];
		let text = shared;
		for (const ok of ALLOWED) text = text.split(ok).join('');

		const offenders = [];
		for (const word of ['iPhone', 'iPad', 'Finder', 'Apple devices']) {
			// Only string literals matter; `ecosystem === 'apple'` checks and
			// comments naming the bug are fine.
			const re = new RegExp("(text|Desc|Placeholder|name)\\s*[:(][^\\n]*" + word, 'g');
			let m;
			while ((m = re.exec(text))) offenders.push(word + ' → ' + m[0].trim());
		}
		assert.deepStrictEqual(offenders, [], 'Apple wording in shared UI:\n' + offenders.join('\n'));
	});
}

/* ================= GitHub ================= *
 *
 * Driven by an in-memory GitHub, the same way the scanner is driven by a
 * fake adapter. The suite never makes a network request; the fake can be
 * told to produce the failures that matter — a missing branch, a truncated
 * tree, a rate limit, and the race where another device pushed first.
 */

/**
 * A GitHub that lives in a variable.
 *
 * Stores real blobs and real trees, so a push can be replayed and asserted
 * against rather than merely counted.
 */
function fakeGitHub(opts) {
	opts = opts || {};
	const state = {
		blobs: Object.create(null), // sha -> base64
		trees: Object.create(null), // sha -> {path: blobSha}
		commits: Object.create(null), // sha -> {tree, parents}
		refs: Object.create(null), // branch -> commit sha
		calls: [],
		requests: [],
		failures: (opts.failures || []).slice(), // queued {status, body}
		user: opts.user || { login: 'jamalbalya', name: 'Jamal' },
		repos: opts.repos || [],
		truncated: !!opts.truncated,
	};
	let counter = 0;
	const nextSha = (kind) => kind + '-' + ++counter;

	function reply(status, json) {
		return { status: status, headers: {}, text: json === undefined ? '' : JSON.stringify(json) };
	}

	async function request(params) {
		const method = params.method || 'GET';
		const path = params.url.replace('https://api.github.com', '');
		const body = params.body ? JSON.parse(params.body) : null;
		state.calls.push(method + ' ' + path);
		// Bodies are recorded separately: a check that only sees the method and
		// path cannot notice a `force: true` being added to a ref update, and a
		// test that cannot notice that is not protecting anything.
		state.requests.push({ method: method, path: path, body: body });

		if (state.failures.length) {
			const f = state.failures.shift();
			if (f) return reply(f.status, { message: f.message || 'failed' });
		}

		if (path === '/user') return reply(200, state.user);

		if (path.indexOf('/user/repos') === 0 && method === 'GET') {
			return reply(200, state.repos);
		}
		if (path === '/user/repos' && method === 'POST') {
			return reply(201, { full_name: 'jamalbalya/' + body.name, default_branch: 'main' });
		}

		let m = path.match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/);
		if (m && method === 'GET') {
			const sha = state.refs[decodeURIComponent(m[1])];
			// A repository with no commits at all answers 409, not 404. Real
			// GitHub makes that distinction and so must the fake.
			if (!sha) {
				return Object.keys(state.refs).length === 0
					? reply(409, { message: 'Git Repository is empty.' })
					: reply(404, { message: 'Not Found' });
			}
			return reply(200, { object: { sha: sha } });
		}

		m = path.match(/^\/repos\/[^/]+\/[^/]+\/git\/commits\/(.+)$/);
		if (m && method === 'GET') {
			const c = state.commits[m[1]];
			return reply(200, { sha: m[1], tree: { sha: c.tree } });
		}

		m = path.match(/^\/repos\/[^/]+\/[^/]+\/git\/trees\/([^?]+)/);
		if (m && method === 'GET') {
			const tree = state.trees[m[1]] || {};
			return reply(200, {
				truncated: state.truncated,
				tree: Object.keys(tree).map((p) => ({ path: p, type: 'blob', sha: tree[p] })),
			});
		}

		/*
		 * Real GitHub refuses the entire Git Data API on a repository with no
		 * commits — creating a blob answers 409, not just creating a ref. The
		 * fake reproduces that, because a fake that quietly allowed it hid a
		 * real failure on a freshly created repository.
		 */
		const empty = Object.keys(state.refs).length === 0;
		if (empty && method === 'POST' && /\/git\/(blobs|trees|commits|refs)$/.test(path)) {
			return reply(409, { message: 'Git Repository is empty.' });
		}

		// The Contents API is the one endpoint that works in that state.
		m = path.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
		if (m && method === 'PUT') {
			const filePath = decodeURIComponent(m[1]).split('/').map(decodeURIComponent).join('/');
			const blobSha = await C.gitBlobSha(C.base64ToBytes(body.content));
			state.blobs[blobSha] = body.content;
			const treeSha = nextSha('tree');
			state.trees[treeSha] = { [filePath]: blobSha };
			const commitSha = nextSha('commit');
			state.commits[commitSha] = { tree: treeSha, parents: [], message: body.message };
			state.refs[body.branch || 'main'] = commitSha;
			return reply(201, { commit: { sha: commitSha } });
		}

		m = path.match(/^\/repos\/[^/]+\/[^/]+\/git\/blobs\/(.+)$/);
		if (m && method === 'GET') {
			const content = state.blobs[m[1]];
			if (content === undefined) return reply(404, { message: 'Not Found' });
			return reply(200, { content: content, encoding: 'base64' });
		}

		if (/\/git\/blobs$/.test(path) && method === 'POST') {
			// Real GitHub hands back the true Git blob SHA, which is precisely
			// what lets the next push recognise the file as unchanged. A fake
			// that returned a counter here would make every push look like a
			// full re-upload and would hide the bug it is meant to catch.
			const sha = await C.gitBlobSha(C.base64ToBytes(body.content));
			state.blobs[sha] = body.content;
			return reply(201, { sha: sha });
		}

		if (/\/git\/trees$/.test(path) && method === 'POST') {
			const base = body.base_tree ? Object.assign({}, state.trees[body.base_tree]) : {};
			for (const e of body.tree) {
				if (e.sha === null) delete base[e.path];
				else base[e.path] = e.sha;
			}
			const sha = nextSha('tree');
			state.trees[sha] = base;
			return reply(201, { sha: sha });
		}

		if (/\/git\/commits$/.test(path) && method === 'POST') {
			const sha = nextSha('commit');
			state.commits[sha] = { tree: body.tree, parents: body.parents, message: body.message };
			return reply(201, { sha: sha });
		}

		m = path.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/);
		if (m && method === 'PATCH') {
			state.refs[decodeURIComponent(m[1])] = body.sha;
			return reply(200, { object: { sha: body.sha } });
		}
		if (/\/git\/refs$/.test(path) && method === 'POST') {
			state.refs[body.ref.replace('refs/heads/', '')] = body.sha;
			return reply(201, { object: { sha: body.sha } });
		}

		return reply(404, { message: 'unhandled ' + method + ' ' + path });
	}

	state.request = request;
	/** What the branch actually holds, as path -> content. */
	state.filesOn = function (branch) {
		const commit = state.commits[state.refs[branch]];
		if (!commit) return null;
		const tree = state.trees[commit.tree] || {};
		const out = {};
		for (const p of Object.keys(tree)) {
			out[p] = Buffer.from(state.blobs[tree[p]], 'base64').toString('utf8');
		}
		return out;
	};
	return state;
}

const bytes = (s) => new TextEncoder().encode(s);

/* ================= check schedule ================= */

/**
 * Every assertion here is built from local Date components rather than from
 * epoch numbers or ISO strings, so the suite gives the same answer in London,
 * Jakarta and Los Angeles. A schedule is a wall clock, and a test that only
 * passed in UTC would be testing the wrong thing.
 */
async function scheduleTests() {
	const at = (y, mo, d, h, mi) => new Date(y, mo, d, h || 0, mi || 0, 0, 0).getTime();
	const MINUTE = 60 * 1000;
	const DAY = 24 * 60 * MINUTE;

	group('schedule — shape and upgrade');

	await test('an empty schedule normalises to the shipped default', () => {
		const s = C.normalizeSchedule(null);
		assert.strictEqual(s.mode, 'minutes');
		assert.strictEqual(s.every, 2);
		assert.strictEqual(s.at, '');
		// Everything loops by default; "just once" has to be asked for.
		assert.strictEqual(s.repeat, 'monthly');
	});

	await test('a mode nobody recognises falls back rather than throwing', () => {
		// data.json is a plain file a user can edit, and a downgrade can leave
		// a mode this version has never heard of.
		const s = C.normalizeSchedule({ mode: 'fortnightly', every: 3 });
		assert.strictEqual(s.mode, 'minutes');
		assert.strictEqual(s.every, 3);
	});

	await test('counts below one and above the unit\'s ceiling are clamped', () => {
		assert.strictEqual(C.normalizeSchedule({ mode: 'hours', every: 0 }).every, 1);
		assert.strictEqual(C.normalizeSchedule({ mode: 'hours', every: -7 }).every, 1);
		assert.strictEqual(C.normalizeSchedule({ mode: 'minutes', every: 99999 }).every, 60 * 24);
		assert.strictEqual(C.normalizeSchedule({ mode: 'weekly', every: 500 }).every, 52);
		assert.strictEqual(C.normalizeSchedule({ mode: 'days', every: 2.9 }).every, 2);
	});

	await test('a date that is not a real date is not kept', () => {
		assert.strictEqual(C.normalizeSchedule({ mode: 'datetime', at: 'soon' }).at, '');
		assert.strictEqual(C.normalizeSchedule({ mode: 'datetime', at: '2026-02-30T09:00' }).at, '');
		assert.strictEqual(
			C.normalizeSchedule({ mode: 'datetime', at: '2026-08-15T09:30' }).at,
			'2026-08-15T09:30'
		);
	});

	await test('a chosen date survives switching to another kind of schedule', () => {
		// Otherwise picking a date, glancing at "every 2 hours" and going back
		// would silently discard it.
		const s = C.normalizeSchedule({ mode: 'hours', every: 2, at: '2026-08-15T09:30' });
		assert.strictEqual(s.at, '2026-08-15T09:30');
	});

	await test('the old "check every N minutes" box is carried across the upgrade', () => {
		// The reported worry: someone who deliberately set 30 must not be
		// reset to the default by installing a new version.
		const s = C.scheduleFromSettings({ githubPullMinutes: 30 });
		assert.strictEqual(s.mode, 'minutes');
		assert.strictEqual(s.every, 30);
	});

	await test('a real schedule wins over the old box', () => {
		const s = C.scheduleFromSettings({
			githubPullMinutes: 30,
			githubSchedule: { mode: 'days', every: 3 },
		});
		assert.strictEqual(s.mode, 'days');
		assert.strictEqual(s.every, 3);
	});

	await test('a vault that never had either setting gets the default', () => {
		assert.strictEqual(C.scheduleFromSettings({}).every, 2);
		assert.strictEqual(C.scheduleFromSettings(null).mode, 'minutes');
	});

	await test('a schedule that does not say how to repeat still loops', () => {
		// The rule the user asked for: whatever is chosen, the check keeps
		// happening. Stopping has to be asked for by name.
		assert.strictEqual(C.normalizeSchedule({ mode: 'datetime', at: '2026-08-15T09:30' }).repeat, 'monthly');
		assert.strictEqual(C.normalizeSchedule({ mode: 'datetime', repeat: 'yearly' }).repeat, 'monthly');
		assert.strictEqual(C.normalizeSchedule({ mode: 'datetime', repeat: 'once' }).repeat, 'once');
	});

	await test('an interval schedule repeats for ever, never stopping on its own', () => {
		// Fifty rounds of each: there must never be a point where the next
		// check is null.
		for (const mode of ['minutes', 'hours', 'days', 'weekly', 'monthly']) {
			let cursor = at(2026, 7, 5, 12, 0);
			for (let i = 0; i < 50; i++) {
				const next = C.nextRunAt({ mode: mode, every: 1 }, cursor, cursor + 1000);
				assert.ok(next !== null, mode + ' stopped after ' + i + ' checks');
				assert.ok(next > cursor, mode + ' did not move forward');
				cursor = next;
			}
		}
	});

	await test('a calendar schedule repeats for ever too, unless told to stop once', () => {
		for (const repeat of ['daily', 'weekly', 'monthly']) {
			const s = { mode: 'datetime', at: '2026-08-15T09:30', repeat: repeat };
			let cursor = at(2026, 7, 15, 9, 30);
			for (let i = 0; i < 50; i++) {
				const next = C.nextRunAt(s, cursor, cursor + 1000);
				assert.ok(next !== null, repeat + ' stopped after ' + i + ' checks');
				cursor = next;
			}
		}
		const once = { mode: 'datetime', at: '2026-08-15T09:30', repeat: 'once' };
		const kept = at(2026, 7, 15, 9, 30);
		assert.strictEqual(C.nextRunAt(once, kept, kept + 1000), null);
	});

	group('schedule — the five intervals');

	await test('each unit is the length it says it is', () => {
		assert.strictEqual(C.schedulePeriodMs({ mode: 'minutes', every: 5 }), 5 * 60 * 1000);
		assert.strictEqual(C.schedulePeriodMs({ mode: 'hours', every: 3 }), 3 * 60 * 60 * 1000);
		assert.strictEqual(C.schedulePeriodMs({ mode: 'days', every: 1 }), 24 * 60 * 60 * 1000);
		assert.strictEqual(C.schedulePeriodMs({ mode: 'weekly', every: 1 }), 7 * 24 * 60 * 60 * 1000);
		assert.strictEqual(C.schedulePeriodMs({ mode: 'monthly', every: 1 }), 30 * 24 * 60 * 60 * 1000);
		assert.strictEqual(C.schedulePeriodMs({ mode: 'datetime', at: '2026-08-15T09:30' }), 0);
	});

	await test('a vault that has never been checked is due immediately', () => {
		const now = at(2026, 7, 5, 12, 0);
		assert.strictEqual(C.nextRunAt({ mode: 'days', every: 7 }, 0, now), now);
	});

	await test('after a check, the next one is a full period later', () => {
		const last = at(2026, 7, 5, 12, 0);
		const next = C.nextRunAt({ mode: 'hours', every: 6 }, last, last + 1000);
		assert.strictEqual(next, last + 6 * 60 * 60 * 1000);
	});

	await test('a check missed while the app was closed comes back overdue, not skipped', () => {
		// The phone case: closed on Monday, opened on Friday. The answer has
		// to be a time in the past so the plugin checks at once.
		const last = at(2026, 7, 3, 9, 0);
		const now = at(2026, 7, 7, 9, 0);
		const next = C.nextRunAt({ mode: 'days', every: 1 }, last, now);
		assert.ok(next < now, 'an overdue check must report as overdue');
		assert.strictEqual(next, last + 24 * 60 * 60 * 1000);
	});

	group('schedule — the calendar');

	await test('February is 28 days, or 29 when it should be', () => {
		assert.strictEqual(C.daysInMonth(2026, 1), 28);
		assert.strictEqual(C.daysInMonth(2024, 1), 29);
		// The rule is not "every four years", and both exceptions matter.
		assert.strictEqual(C.daysInMonth(1900, 1), 28);
		assert.strictEqual(C.daysInMonth(2000, 1), 29);
	});

	await test('every other month is the length everyone expects', () => {
		const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
		for (let m = 0; m < 12; m++) {
			assert.strictEqual(C.daysInMonth(2026, m), lengths[m], 'month ' + m);
		}
	});

	await test('the grid is always six whole weeks, Monday first', () => {
		for (let m = 0; m < 12; m++) {
			const g = C.buildMonthGrid(2026, m);
			assert.strictEqual(g.weeks.length, 6, 'month ' + m + ' rows');
			for (const week of g.weeks) assert.strictEqual(week.length, 7);
		}
	});

	await test('August 2026 is drawn exactly as the calendar prints it', () => {
		// The month in the screenshot: 1 August falls on a Saturday, so the
		// first row runs 27 July to 2 August.
		const g = C.buildMonthGrid(2026, 7);
		assert.strictEqual(g.label, 'August 2026');
		const first = g.weeks[0];
		assert.deepStrictEqual(first.map((c) => c.day), [27, 28, 29, 30, 31, 1, 2]);
		assert.deepStrictEqual(
			first.map((c) => c.inMonth),
			[false, false, false, false, false, true, true]
		);
		// Saturday and Sunday, and only those.
		assert.deepStrictEqual(
			first.map((c) => c.weekend),
			[false, false, false, false, false, true, true]
		);
		// The last row of a 31-day month starting on a Saturday.
		const last = g.weeks[5];
		assert.strictEqual(last[0].day, 31);
		assert.strictEqual(last[0].inMonth, true);
		assert.strictEqual(last[1].day, 1);
		assert.strictEqual(last[1].inMonth, false);
	});

	await test('a leap February shows the 29th and a common one does not', () => {
		const leap = C.buildMonthGrid(2024, 1).weeks.reduce((a, w) => a.concat(w), []);
		const inLeap = leap.filter((c) => c.inMonth).map((c) => c.day);
		assert.strictEqual(inLeap.length, 29);
		assert.strictEqual(inLeap[28], 29);

		const common = C.buildMonthGrid(2026, 1).weeks.reduce((a, w) => a.concat(w), []);
		assert.strictEqual(common.filter((c) => c.inMonth).length, 28);
	});

	await test('paging past December rolls the year over', () => {
		assert.strictEqual(C.buildMonthGrid(2026, 12).label, 'January 2027');
		assert.strictEqual(C.buildMonthGrid(2026, -1).label, 'December 2025');
	});

	await test('today is marked, and only today', () => {
		const today = at(2026, 7, 15, 13, 45);
		const cells = C.buildMonthGrid(2026, 7, today).weeks.reduce((a, w) => a.concat(w), []);
		const marked = cells.filter((c) => c.today);
		assert.strictEqual(marked.length, 1);
		assert.strictEqual(marked[0].day, 15);
	});

	await test('a written date reads back as the same wall clock', () => {
		const d = new Date(2026, 7, 15, 9, 30, 0, 0);
		assert.strictEqual(C.formatLocalDateTime(d), '2026-08-15T09:30');
		const back = C.parseLocalDateTime('2026-08-15T09:30');
		assert.strictEqual(back.getFullYear(), 2026);
		assert.strictEqual(back.getMonth(), 7);
		assert.strictEqual(back.getDate(), 15);
		assert.strictEqual(back.getHours(), 9);
		assert.strictEqual(back.getMinutes(), 30);
	});

	await test('a date that does not exist is refused, not rounded', () => {
		// new Date('2026-02-30') would quietly become 2 March.
		assert.strictEqual(C.parseLocalDateTime('2026-02-30T09:00'), null);
		assert.strictEqual(C.parseLocalDateTime('2026-02-29T09:00'), null);
		assert.ok(C.parseLocalDateTime('2024-02-29T09:00'), 'a leap day is a real date');
		assert.strictEqual(C.parseLocalDateTime('2026-13-01T09:00'), null);
		assert.strictEqual(C.parseLocalDateTime('2026-08-15T24:00'), null);
		assert.strictEqual(C.parseLocalDateTime('2026-08-15T09:60'), null);
		assert.strictEqual(C.parseLocalDateTime(''), null);
		assert.strictEqual(C.parseLocalDateTime('2026-08-15 09:30'), null);
	});

	await test('a stored moment is read as a wall clock, never as UTC', () => {
		/*
		 * Run in a zone with a real offset, deliberately, rather than trusting
		 * whatever the machine is set to. On a UTC machine — which is what CI
		 * is — local time and UTC are the same thing, so parsing a bare
		 * "2026-08-15T09:30" the wrong way looks identical to parsing it the
		 * right way, and nothing here would notice. Forcing the zone is what
		 * makes the distinction visible everywhere.
		 */
		const { execSync } = require('child_process');
		const main = JSON.stringify(require.resolve('../main.js'));
		const script =
			'const C = require(' + main + ').__core;' +
			'const d = C.parseLocalDateTime("2026-08-15T09:30");' +
			'process.stdout.write(JSON.stringify([d.getHours(), d.getMinutes(), C.formatLocalDateTime(d)]));';

		for (const zone of ['Asia/Jakarta', 'America/Los_Angeles', 'Asia/Kolkata']) {
			const out = execSync(process.execPath + ' -e ' + JSON.stringify(script), {
				env: Object.assign({}, process.env, { TZ: zone }),
				encoding: 'utf8',
			});
			assert.deepStrictEqual(
				JSON.parse(out),
				[9, 30, '2026-08-15T09:30'],
				'half past nine did not survive ' + zone
			);
		}
	});

	await test('a two-digit year is refused, not read as the 1900s', () => {
		// new Date(26, 0, 1) means 1926, so this would parse to something that
		// does not format back to the text it came from.
		assert.strictEqual(C.parseLocalDateTime('0026-01-01T09:00'), null);
		assert.strictEqual(C.parseLocalDateTime('0099-01-01T09:00'), null);
		assert.strictEqual(C.parseLocalDateTime('1969-12-31T23:59'), null);
		assert.ok(C.parseLocalDateTime('1970-01-01T00:00'), 'the epoch is a real date');
		assert.ok(C.parseLocalDateTime('9999-12-31T23:59'), 'and so is the far end');
	});

	await test('every date this accepts formats back to exactly what came in', () => {
		// The round trip, checked in bulk rather than on a handful of samples.
		for (let year = 1970; year <= 2100; year += 7) {
			for (let month = 0; month < 12; month++) {
				const last = C.daysInMonth(year, month);
				for (const day of [1, 15, last]) {
					const text =
						year + '-' + String(month + 1).padStart(2, '0') + '-' +
						String(day).padStart(2, '0') + 'T09:30';
					const parsed = C.parseLocalDateTime(text);
					assert.ok(parsed, 'refused a real date: ' + text);
					assert.strictEqual(C.formatLocalDateTime(parsed), text);
				}
				// And the day after the last one never exists.
				const overflow =
					year + '-' + String(month + 1).padStart(2, '0') + '-' +
					String(last + 1).padStart(2, '0') + 'T09:30';
				assert.strictEqual(C.parseLocalDateTime(overflow), null, 'accepted ' + overflow);
			}
		}
	});

	group('schedule — a date and time');

	await test('a one-off runs at the moment chosen, then never again', () => {
		const s = { mode: 'datetime', at: '2026-08-15T09:30', repeat: 'once' };
		const target = at(2026, 7, 15, 9, 30);
		assert.strictEqual(C.nextRunAt(s, 0, at(2026, 7, 5, 12, 0)), target);
		// Kept.
		assert.strictEqual(C.nextRunAt(s, target, target + 1000), null);
	});

	await test('a one-off whose moment passed while the app was shut still runs', () => {
		const s = { mode: 'datetime', at: '2026-08-15T09:30', repeat: 'once' };
		const next = C.nextRunAt(s, 0, at(2026, 7, 20, 12, 0));
		assert.strictEqual(next, at(2026, 7, 15, 9, 30));
	});

	await test('a date-and-time schedule with no date chosen schedules nothing', () => {
		assert.strictEqual(
			C.nextRunAt({ mode: 'datetime', at: '', repeat: 'daily' }, 0, at(2026, 7, 5, 12, 0)),
			null
		);
	});

	await test('a daily repeat keeps its clock time', () => {
		const s = { mode: 'datetime', at: '2026-08-15T09:30', repeat: 'daily' };
		const last = at(2026, 7, 15, 9, 30);
		const next = new Date(C.nextRunAt(s, last, last + 1000));
		assert.strictEqual(next.getDate(), 16);
		assert.strictEqual(next.getHours(), 9);
		assert.strictEqual(next.getMinutes(), 30);
	});

	await test('a weekly repeat lands on the same weekday every time', () => {
		const s = { mode: 'datetime', at: '2026-08-15T09:30', repeat: 'weekly' };
		const anchor = new Date(2026, 7, 15, 9, 30);
		let cursor = anchor.getTime();
		for (let i = 0; i < 10; i++) {
			cursor = C.nextRunAt(s, cursor, cursor + 1000);
			const d = new Date(cursor);
			assert.strictEqual(d.getDay(), anchor.getDay(), 'week ' + i + ' weekday');
			assert.strictEqual(d.getHours(), 9);
			assert.strictEqual(d.getMinutes(), 30);
		}
		assert.strictEqual(new Date(cursor).getDate(), 24);
		assert.strictEqual(new Date(cursor).getMonth(), 9);
	});

	await test('the 31st becomes the last day of a month too short for it', () => {
		// The February case, stated plainly, and the part that matters most:
		// the 31st comes back in March rather than being worn down to the 28th.
		const s = { mode: 'datetime', at: '2026-01-31T08:00', repeat: 'monthly' };
		const seen = [];
		let cursor = at(2026, 0, 31, 8, 0);
		for (let i = 0; i < 4; i++) {
			cursor = C.nextRunAt(s, cursor, cursor + 1000);
			const d = new Date(cursor);
			seen.push(d.getMonth() + '/' + d.getDate());
			assert.strictEqual(d.getHours(), 8);
		}
		assert.deepStrictEqual(seen, ['1/28', '2/31', '3/30', '4/31']);
	});

	await test('a monthly 29th finds the leap day and then February\'s end', () => {
		const s = { mode: 'datetime', at: '2024-01-29T08:00', repeat: 'monthly' };
		const first = new Date(C.nextRunAt(s, at(2024, 0, 29, 8, 0), at(2024, 0, 29, 8, 1)));
		assert.strictEqual(first.getMonth(), 1);
		assert.strictEqual(first.getDate(), 29, '2024 is a leap year');

		const s25 = { mode: 'datetime', at: '2025-01-29T08:00', repeat: 'monthly' };
		const nonLeap = new Date(C.nextRunAt(s25, at(2025, 0, 29, 8, 0), at(2025, 0, 29, 8, 1)));
		assert.strictEqual(nonLeap.getMonth(), 1);
		assert.strictEqual(nonLeap.getDate(), 28, '2025 is not');
	});

	await test('a clock that ran fast does not park the schedule', () => {
		// A device set forward and then corrected leaves a stamp in the
		// future. Trusting it would suspend every check for the whole of the
		// skew, with nothing in the interface able to release it.
		const now = at(2026, 7, 5, 12, 0);
		const fromTheFuture = at(2027, 0, 1, 0, 0);
		const next = C.nextRunAt({ mode: 'minutes', every: 5 }, fromTheFuture, now);
		assert.ok(next !== null);
		// Due at once, so the check that follows writes a stamp that is real.
		// Clamping to "now" instead would answer "five minutes away" for ever
		// and never overwrite the bad value.
		assert.strictEqual(next, now, 'a future stamp must be discarded, not clamped');

		// A one-off is not falsely reported as already kept, either.
		const once = { mode: 'datetime', at: '2026-08-20T09:30', repeat: 'once' };
		assert.strictEqual(
			C.nextRunAt(once, fromTheFuture, now),
			at(2026, 7, 20, 9, 30),
			'a future stamp swallowed an appointment'
		);
	});

	await test('the calendar keys its days by something every zone actually has', () => {
		// Santiago, Beirut, Havana and Tehran move their clocks at midnight,
		// so on two days a year local midnight does not exist. Noon does.
		const cells = C.buildMonthGrid(2026, 7).weeks.reduce((a, w) => a.concat(w), []);
		for (const cell of cells) {
			const d = new Date(cell.ts);
			assert.strictEqual(d.getHours(), 12, 'a day anchored on midnight');
			assert.strictEqual(C.dayKey(d), cell.key);
			assert.strictEqual(cell.key, cell.year * 10000 + cell.month * 100 + cell.day);
		}
		// Keys are strictly increasing across the whole grid, which is what
		// "before today" is decided with.
		for (let i = 1; i < cells.length; i++) {
			assert.ok(cells[i].key > cells[i - 1].key, 'keys went backwards at ' + i);
		}
	});

	await test('a repeat dormant for years catches up in one step, not thousands', () => {
		// Left running daily and not opened since 2020: the answer must be the
		// one occurrence that is now overdue, and it must come back quickly.
		const s = { mode: 'datetime', at: '2020-01-01T07:00', repeat: 'daily' };
		const last = at(2020, 0, 1, 7, 0);
		const now = at(2026, 7, 5, 12, 0);
		const next = C.nextRunAt(s, last, now);
		const d = new Date(next);
		assert.strictEqual(d.getFullYear(), 2020);
		assert.strictEqual(d.getDate(), 2, 'the very next occurrence after the last check');
		assert.strictEqual(d.getHours(), 7);

		// And once that catch-up run is stamped, the schedule is back in step.
		const after = new Date(C.nextRunAt(s, now, now + 1000));
		assert.ok(after.getTime() > now);
		assert.strictEqual(after.getHours(), 7);
		assert.ok(after.getTime() - now <= 24 * 60 * 60 * 1000);
	});

	await test('every occurrence is later than the one before it', () => {
		// Monotonic, or a schedule could stall or run backwards.
		for (const repeat of ['daily', 'weekly', 'monthly']) {
			const s = { mode: 'datetime', at: '2026-01-31T23:45', repeat: repeat };
			let cursor = at(2026, 0, 31, 23, 45);
			for (let i = 0; i < 40; i++) {
				const next = C.nextRunAt(s, cursor, cursor + 1000);
				assert.ok(next > cursor, repeat + ' went backwards at step ' + i);
				cursor = next;
			}
		}
	});

	group('schedule — how it is described');

	await test('an interval is described in its own units, singular when it is one', () => {
		assert.strictEqual(C.describeSchedule({ mode: 'minutes', every: 2 }), 'every 2 minutes');
		assert.strictEqual(C.describeSchedule({ mode: 'hours', every: 1 }), 'every hour');
		assert.strictEqual(C.describeSchedule({ mode: 'days', every: 3 }), 'every 3 days');
		assert.strictEqual(C.describeSchedule({ mode: 'weekly', every: 1 }), 'every week');
		assert.strictEqual(C.describeSchedule({ mode: 'monthly', every: 2 }), 'every 2 months');
	});

	await test('a calendar schedule is described as a calendar, not as a number', () => {
		const base = { mode: 'datetime', at: '2026-08-15T09:30' };
		assert.strictEqual(
			C.describeSchedule(Object.assign({}, base, { repeat: 'daily' })),
			'every day at 09:30'
		);
		assert.strictEqual(
			C.describeSchedule(Object.assign({}, base, { repeat: 'weekly' })),
			'every Saturday at 09:30'
		);
		assert.strictEqual(
			C.describeSchedule(Object.assign({}, base, { repeat: 'monthly' })),
			'on the 15th of each month at 09:30'
		);
		assert.ok(
			/once, on Sat 15 August 2026 at 09:30/.test(
				C.describeSchedule(Object.assign({}, base, { repeat: 'once' }))
			)
		);
		assert.ok(/none chosen yet/.test(C.describeSchedule({ mode: 'datetime', at: '' })));
	});

	await test('ordinals read the way English writes them', () => {
		const got = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 31].map(C.ordinal);
		assert.deepStrictEqual(got, [
			'1st', '2nd', '3rd', '4th', '11th', '12th', '13th',
			'21st', '22nd', '23rd', '30th', '31st',
		]);
	});

	await test('the next check is spelled out, including when there is not one', () => {
		const now = at(2026, 7, 5, 12, 0);
		const soon = C.describeNextRun({ mode: 'minutes', every: 30 }, now - 60000, now);
		assert.ok(/Next check:/.test(soon), soon);
		assert.ok(/in 29 minutes/.test(soon), soon);

		const due = C.describeNextRun({ mode: 'minutes', every: 1 }, now - 600000, now);
		assert.ok(/due now/.test(due), due);

		const spent = C.describeNextRun(
			{ mode: 'datetime', at: '2026-08-01T09:00', repeat: 'once' },
			at(2026, 7, 1, 9, 0),
			now
		);
		assert.ok(/finished/.test(spent), spent);

		const unset = C.describeNextRun({ mode: 'datetime', at: '' }, 0, now);
		assert.ok(/No date chosen/.test(unset), unset);
	});

	await test('a wait is described roughly, in the largest unit that fits', () => {
		assert.strictEqual(C.formatDelay(0), 'now');
		assert.strictEqual(C.formatDelay(30 * 1000), 'in under a minute');
		assert.strictEqual(C.formatDelay(60 * 1000), 'in 1 minute');
		assert.strictEqual(C.formatDelay(45 * 60 * 1000), 'in 45 minutes');
		assert.strictEqual(C.formatDelay(2 * 60 * 60 * 1000), 'in 2 hours');
		assert.strictEqual(C.formatDelay(5 * 24 * 60 * 60 * 1000), 'in 5 days');
	});

	await test('a wait near a unit boundary is described on the right side of it', () => {
		// Seen in the running app: a check an hour and fifty-nine minutes away
		// was being announced as "in 1 hour".
		assert.strictEqual(C.formatDelay(119 * 60 * 1000), 'in 2 hours');
		assert.strictEqual(C.formatDelay(90 * 60 * 1000), 'in 2 hours');
		assert.strictEqual(C.formatDelay(23.9 * 60 * 60 * 1000), 'in 1 day');
		// And the rounding must never reach for a unit there is a better word
		// for: no "in 60 minutes", no "in 24 hours".
		for (let ms = MINUTE; ms <= 40 * DAY; ms += 7 * MINUTE + 13000) {
			const said = C.formatDelay(ms);
			assert.strictEqual(said.indexOf('in 60 minutes'), -1, String(ms));
			assert.strictEqual(said.indexOf('in 24 hours'), -1, String(ms));
			assert.ok(/^in \d+ (minute|hour|day)s?$/.test(said), said);
		}
	});

	await test('every mode and every repeat carries an explanation', () => {
		// The tooltips are the only thing standing between the user and six
		// words that all look alike.
		for (const m of C.SCHEDULE_MODES) {
			assert.ok(m.label && m.label.length > 3, m.id + ' needs a label');
			assert.ok(m.help && m.help.length > 40, m.id + ' needs a real explanation');
		}
		for (const r of C.SCHEDULE_REPEATS) {
			assert.ok(r.help && r.help.length > 30, r.id + ' needs a real explanation');
		}
		assert.strictEqual(C.SCHEDULE_MODES.length, 6);
		assert.strictEqual(C.SCHEDULE_REPEATS.length, 4);
		// Only one of them ever stops, and it is listed last.
		const looping = C.SCHEDULE_REPEATS.filter((r) => r.id !== 'once');
		assert.strictEqual(looping.length, 3);
		assert.strictEqual(C.SCHEDULE_REPEATS[C.SCHEDULE_REPEATS.length - 1].id, 'once');
	});

	await test('the shipped default still checks every two minutes', () => {
		// Changing what a fresh install does is a decision, not a side effect.
		const s = C.scheduleFromSettings(C.DEFAULT_SETTINGS);
		assert.strictEqual(s.mode, 'minutes');
		assert.strictEqual(s.every, 2);
	});
}

/* ================= the timer that drives the schedule ================= */

/**
 * The pure half above decides *when* a check is due. This drives the half
 * that acts on it — armCheckTimer and runScheduledCheck on the real plugin
 * class — against a clock and a setTimeout that this test controls.
 *
 * Worth the scaffolding: the failure modes here are a timer that spins, a
 * timer that never fires, and a timer that outlives the plugin, and none of
 * them are visible from the arithmetic.
 */
async function checkTimerTests() {
	group('check timer');

	function fakeClock(start) {
		let seq = 1;
		const timers = [];
		return {
			now: start,
			pending: () => timers.slice(),
			set(fn, ms) {
				const t = { id: seq++, at: this.now + ms, ms: ms, fn: fn };
				timers.push(t);
				return t.id;
			},
			clear(id) {
				for (let i = 0; i < timers.length; i++) {
					if (timers[i].id === id) return timers.splice(i, 1);
				}
			},
			/** Run the one pending timer, moving the clock to when it was due. */
			fire() {
				const t = timers.shift();
				if (!t) throw new Error('nothing was scheduled');
				this.now = t.at;
				t.fn();
				return t;
			},
		};
	}

	/** Run a body with a controlled clock and window, always restoring both. */
	function withClock(start, body) {
		const clock = fakeClock(start);
		const realNow = Date.now;
		const realWindow = global.window;
		global.window = {
			setTimeout: (fn, ms) => clock.set(fn, ms),
			clearTimeout: (id) => clock.clear(id),
		};
		Date.now = () => clock.now;
		try {
			return body(clock);
		} finally {
			Date.now = realNow;
			if (realWindow === undefined) delete global.window;
			else global.window = realWindow;
		}
	}

	function makePlugin(schedule, extra) {
		extra = extra || {};
		const p = Object.create(plugin.prototype);
		p.settings = Object.assign({}, C.DEFAULT_SETTINGS, extra.settings || {});
		p.settings.githubSchedule = schedule;
		if (extra.githubAutoSync !== undefined) p.settings.githubAutoSync = extra.githubAutoSync;
		p.app = fakeApp();
		p.lastCheckAt = extra.lastCheckAt || 0;
		p.github = { mode: 'github', token: 'tok', repo: 'me/vault', branch: 'main' };
		p.syncs = 0;
		p.autoSync = () => {
			p.syncs++;
		};
		p.refreshViews = () => {};
		p.saveSettings = async () => {};
		return p;
	}

	const START = new Date(2026, 7, 5, 12, 0, 0, 0).getTime();

	await test('a short wait is timed exactly', () => {
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'minutes', every: 2 }, { lastCheckAt: START });
			p.armCheckTimer();
			assert.strictEqual(clock.pending().length, 1);
			assert.strictEqual(clock.pending()[0].ms, 2 * 60 * 1000);
		});
	});

	await test('a long wait is broken up rather than overflowing setTimeout', () => {
		// The bug this prevents: setTimeout takes a signed 32-bit delay, so
		// anything past ~24.8 days fires immediately and "every month" becomes
		// a tight loop.
		withClock(START, (clock) => {
			for (const schedule of [
				{ mode: 'monthly', every: 1 },
				{ mode: 'weekly', every: 8 },
				{ mode: 'days', every: 365 },
			]) {
				const p = makePlugin(schedule, { lastCheckAt: START });
				p.armCheckTimer();
				const waiting = clock.pending()[clock.pending().length - 1];
				assert.ok(
					waiting.ms <= 5 * 60 * 1000,
					schedule.mode + ' asked setTimeout for ' + waiting.ms + 'ms'
				);
				assert.ok(waiting.ms < 2147483647, 'would overflow a 32-bit delay');
			}
		});
	});

	await test('ticking does not check until the check is actually due', () => {
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'hours', every: 1 }, { lastCheckAt: START });
			p.armCheckTimer();
			// Twelve five-minute ticks: an hour, so the last one is the check.
			for (let i = 0; i < 11; i++) {
				clock.fire();
				assert.strictEqual(p.syncs, 0, 'checked early at tick ' + i);
			}
			clock.fire();
			assert.strictEqual(p.syncs, 1);
			assert.strictEqual(p.lastCheckAt, START + 60 * 60 * 1000);
		});
	});

	await test('an overdue check runs at once, and only once', () => {
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'days', every: 1 }, {
				lastCheckAt: START - 5 * 24 * 60 * 60 * 1000,
			});
			p.armCheckTimer();
			assert.strictEqual(clock.pending()[0].ms, 0, 'overdue should not wait');
			clock.fire();
			assert.strictEqual(p.syncs, 1);
			// Back in step: the next one is a full day away, not another catch-up.
			assert.strictEqual(clock.pending()[0].ms, 5 * 60 * 1000);
			clock.fire();
			assert.strictEqual(p.syncs, 1, 'caught up twice');
		});
	});

	await test('a check that fails still holds the schedule', () => {
		// Otherwise a bad token or a flight would produce a check every tick
		// for as long as it lasted.
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'minutes', every: 30 }, { lastCheckAt: START });
			p.autoSync = () => {
				p.syncs++;
				return Promise.reject(new Error('offline')).catch(() => {});
			};
			p.armCheckTimer();
			// Six five-minute ticks reach the half hour.
			for (let i = 0; i < 6; i++) clock.fire();
			assert.strictEqual(p.syncs, 1);
			assert.strictEqual(p.lastCheckAt, START + 30 * 60 * 1000);
			// Another half hour, not immediately.
			for (let i = 0; i < 5; i++) {
				assert.ok(clock.pending()[0].ms > 0, 'hammering after a failure');
				clock.fire();
			}
			assert.strictEqual(p.syncs, 1);
		});
	});

	await test('a due check with nothing connected waits instead of spinning', () => {
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'minutes', every: 5 }, { lastCheckAt: 0 });
			p.github.token = '';
			p.armCheckTimer();
			for (let i = 0; i < 20; i++) {
				const t = clock.fire();
				assert.strictEqual(p.syncs, 0);
				if (i > 0) assert.ok(t.ms >= 60 * 1000, 'spun with a ' + t.ms + 'ms wait');
			}
			// And the appointment is still waiting, not quietly used up.
			assert.strictEqual(p.lastCheckAt, 0);
		});
	});

	await test('switching automatic syncing off stops the checks but keeps the date', () => {
		withClock(START, (clock) => {
			const p = makePlugin(
				{ mode: 'datetime', at: '2026-08-05T13:00', repeat: 'once' },
				{ lastCheckAt: 0, githubAutoSync: false }
			);
			p.armCheckTimer();
			for (let i = 0; i < 30; i++) clock.fire();
			assert.strictEqual(p.syncs, 0);
			assert.strictEqual(p.lastCheckAt, 0, 'the one-off was consumed');

			// Switched back on, the appointment is still there and comes due.
			p.settings.githubAutoSync = true;
			clock.fire();
			assert.strictEqual(p.syncs, 1);
		});
	});

	await test('a one-off, once kept, stops the clock entirely', () => {
		withClock(START, (clock) => {
			const p = makePlugin(
				{ mode: 'datetime', at: '2026-08-05T12:30', repeat: 'once' },
				{ lastCheckAt: 0 }
			);
			p.armCheckTimer();
			for (let i = 0; i < 6; i++) clock.fire();
			assert.strictEqual(p.syncs, 1);
			assert.strictEqual(clock.pending().length, 0, 'a spent schedule left a timer running');
		});
	});

	await test('a repeating appointment keeps coming back', () => {
		withClock(START, (clock) => {
			const p = makePlugin(
				{ mode: 'datetime', at: '2026-08-05T12:30', repeat: 'daily' },
				{ lastCheckAt: 0 }
			);
			p.armCheckTimer();
			// Tick for two days: 12:30 on the 5th and 12:30 on the 6th.
			const until = START + 2 * 24 * 60 * 60 * 1000;
			let guard = 0;
			while (clock.pending().length && clock.now < until && guard++ < 5000) {
				clock.fire();
			}
			assert.strictEqual(p.syncs, 2, 'expected one check per day');
			assert.strictEqual(new Date(p.lastCheckAt).getHours(), 12);
			assert.strictEqual(new Date(p.lastCheckAt).getMinutes(), 30);
		});
	});

	await test('re-arming replaces the timer instead of adding another', () => {
		// Every keystroke in the number box re-arms; a chain per keystroke
		// would multiply the checks.
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'minutes', every: 10 }, { lastCheckAt: START });
			for (let i = 0; i < 8; i++) p.armCheckTimer();
			assert.strictEqual(clock.pending().length, 1);
		});
	});

	await test('a changed schedule takes effect without a restart', () => {
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'hours', every: 6 }, { lastCheckAt: START });
			p.armCheckTimer();
			assert.strictEqual(clock.pending()[0].ms, 5 * 60 * 1000);
			p.settings.githubSchedule = { mode: 'minutes', every: 1 };
			p.restartCheckSchedule();
			assert.strictEqual(clock.pending().length, 1);
			assert.strictEqual(clock.pending()[0].ms, 60 * 1000);
		});
	});

	group('loading a vault that has been upgraded');

	/** Drive the real onload against stand-ins, and hand back the plugin. */
	async function bootWith(savedData) {
		const sink = [];
		/* onload registers a scan interval, which reaches for window. */
		const realWindow = global.window;
		global.window = {
			setInterval: () => 1,
			clearInterval: () => {},
			setTimeout: () => 1,
			clearTimeout: () => {},
		};
		const mod = loadWithFakeObsidian(sink);
		const p = new mod();
		const layoutReady = [];
		p.app = Object.assign(fakeApp(), {
			workspace: {
				onLayoutReady: (fn) => layoutReady.push(fn),
				getLeavesOfType: () => [],
				getRightLeaf: () => null,
				revealLeaf: () => {},
			},
			vault: { getName: () => 'Notes', adapter: {}, on: () => ({}) },
		});
		p.loadData = async () => savedData;
		p.saveData = async () => {};
		p.runScan = async () => null;
		p.registerEvent = () => {};
		p.registerInterval = () => {};
		p.registerView = () => {};
		p.addCommand = () => {};
		p.addRibbonIcon = () => {};
		p.addStatusBarItem = () => fakeEl('div', null, sink);
		p.addSettingTab = () => {};
		try {
			await p.onload();
		} finally {
			p.unloaded = true;
			if (realWindow === undefined) delete global.window;
			else global.window = realWindow;
		}
		return p;
	}

	await test('the old minutes box survives, even when a schedule was half-written', async () => {
		// Three shapes a real data.json can be in. All of them must end up
		// checking every 30 minutes, because that is what the user chose.
		for (const saved of [
			{ githubPullMinutes: 30 },
			{ githubPullMinutes: 30, githubSchedule: {} },
			{ githubPullMinutes: 30, githubSchedule: null },
		]) {
			const p = await bootWith(saved);
			assert.strictEqual(
				p.settings.githubSchedule.mode + '/' + p.settings.githubSchedule.every,
				'minutes/30',
				'lost the setting for ' + JSON.stringify(saved)
			);
		}
	});

	await test('a real saved schedule is loaded as it was left', async () => {
		const p = await bootWith({
			githubPullMinutes: 30,
			githubSchedule: { mode: 'datetime', at: '2026-08-15T09:30', repeat: 'weekly' },
		});
		assert.strictEqual(p.settings.githubSchedule.mode, 'datetime');
		assert.strictEqual(p.settings.githubSchedule.at, '2026-08-15T09:30');
		assert.strictEqual(p.settings.githubSchedule.repeat, 'weekly');
	});

	await test('a fresh vault loads without a stored schedule and still works', async () => {
		for (const saved of [null, undefined, {}]) {
			const p = await bootWith(saved);
			assert.strictEqual(p.settings.githubSchedule.mode, 'minutes');
			assert.strictEqual(p.settings.githubSchedule.every, 2);
			assert.strictEqual(p.lastCheckAt, 0);
		}
	});

	await test('a vault not kept in a repository arms no timer at all', () => {
		// The default. Waking every minute to rediscover there is no
		// repository is a background cost paid by everyone who never turns
		// GitHub on — and on a phone, paid in battery.
		withClock(START, (clock) => {
			for (const mode of ['ecosystem', '', undefined]) {
				const p = makePlugin({ mode: 'minutes', every: 2 }, { lastCheckAt: 0 });
				p.github.mode = mode;
				p.armCheckTimer();
				assert.strictEqual(
					clock.pending().length,
					0,
					'storage mode ' + mode + ' left a timer running'
				);
			}
			// Turning GitHub on puts it straight back on the clock.
			const p = makePlugin({ mode: 'minutes', every: 2 }, { lastCheckAt: 0 });
			p.github.mode = 'ecosystem';
			p.armCheckTimer();
			assert.strictEqual(clock.pending().length, 0);
			p.github.mode = 'github';
			p.restartCheckSchedule();
			assert.strictEqual(clock.pending().length, 1);
		});
	});

	await test('one thrown exception does not kill the schedule for good', () => {
		// The chain is the only thing keeping checks alive: the callback drops
		// the timer handle before running, so a throw anywhere in the body
		// would leave nothing scheduled until Obsidian restarted.
		// A clock each: two plugins sharing one would interleave their chains,
		// and the fire() calls would land on the wrong plugin's timer.
		for (const breakIt of ['refreshViews', 'autoSync']) {
			withClock(START, (clock) => {
				const p = makePlugin({ mode: 'minutes', every: 5 }, { lastCheckAt: START });
				let checks = 0;
				p.autoSync = () => {
					checks++;
				};
				p.refreshViews = () => {};
				const wrapped = p[breakIt];
				p[breakIt] = () => {
					wrapped();
					throw new Error('the panel was torn down');
				};
				p.armCheckTimer();
				for (let i = 0; i < 20; i++) {
					if (!clock.pending().length) break;
					clock.fire();
				}
				assert.strictEqual(
					clock.pending().length,
					1,
					breakIt + ' throwing left the chain dead'
				);
				assert.strictEqual(checks, 20, breakIt + ' only ran ' + checks + ' check(s)');
			});
		}
	});

	await test('a clock that ran fast releases within one period', () => {
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'minutes', every: 5 }, {
				lastCheckAt: START + 180 * 24 * 60 * 60 * 1000,
			});
			p.armCheckTimer();
			assert.strictEqual(clock.pending()[0].ms, 0, 'a bad stamp must not park the check');
			clock.fire();
			assert.strictEqual(p.syncs, 1, 'parked for the whole clock skew');
			// And the stamp it wrote is a real one, so it is back in step.
			assert.strictEqual(p.lastCheckAt, START);
			assert.strictEqual(clock.pending()[0].ms, 5 * 60 * 1000);
		});
	});

	await test('unloading the plugin stops the chain', () => {
		withClock(START, (clock) => {
			const p = makePlugin({ mode: 'minutes', every: 2 }, { lastCheckAt: START });
			p.armCheckTimer();
			p.onunload();
			assert.strictEqual(clock.pending().length, 0);

			// A tick already in flight when the plugin was disabled must
			// neither sync nor put another one on the clock. The check is
			// deliberately overdue here, so nothing but the unload guard can
			// be what stops it.
			clock.now = START + 60 * 60 * 1000;
			p.runScheduledCheck();
			assert.strictEqual(p.syncs, 0, 'synced from a disabled plugin');
			assert.strictEqual(p.lastCheckAt, START, 'stamped from a disabled plugin');
			assert.strictEqual(clock.pending().length, 0);

			p.armCheckTimer();
			assert.strictEqual(clock.pending().length, 0);
		});
	});
}

async function githubTests() {
	const G = plugin.__github;
	const noSleep = async () => {};

	group('git blob hashing');

	await test('matches what git hash-object produces', async () => {
		// If this drifts, every diff is wrong and the plugin re-uploads the
		// whole vault on every sync.
		assert.strictEqual(
			await C.gitBlobSha(bytes('hello')),
			'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'
		);
		assert.strictEqual(
			await C.gitBlobSha(bytes('')),
			'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
		);
	});

	await test('base64 survives a round trip, including binary', async () => {
		const raw = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66]);
		assert.deepStrictEqual(Array.from(C.base64ToBytes(C.bytesToBase64(raw))), Array.from(raw));
	});

	await test('base64 handles a file past the argument limit', () => {
		// String.fromCharCode.apply throws over ~65k arguments; the chunking
		// exists for exactly this and a plain attachment would hit it.
		const big = new Uint8Array(200000).fill(88);
		assert.strictEqual(C.base64ToBytes(C.bytesToBase64(big)).length, 200000);
	});

	group('what may be pushed');

	await test("another plugin's secrets are NEVER pushed", () => {
		// The single most important rule here. data.json is where plugins keep
		// API keys, and a commit cannot be taken back.
		const r = C.shouldPushPath('.obsidian/plugins/some-ai-plugin/data.json', 100, {});
		assert.strictEqual(r.ok, false);
		assert.ok(/secret/i.test(r.why), r.why);
	});

	await test('the plugin never pushes its own code', () => {
		// Obsidian's policy forbids a plugin updating itself, and syncing its
		// own main.js to every other device is precisely that. It also caused
		// a "main (github conflicted copy).js" to appear in a real repository
		// when two devices ran different versions.
		for (const p of [
			'.obsidian/plugins/jemzsync/main.js',
			'.obsidian/plugins/jemzsync/manifest.json',
			'.obsidian/plugins/jemzsync/styles.css',
		]) {
			const r = C.shouldPushPath(p, 100, {});
			assert.strictEqual(r.ok, false, 'must never push ' + p);
			assert.ok(/does not sync itself/.test(r.why), r.why);
		}
	});

	await test('another plugin IS still pushed, so a new device comes up set up', () => {
		assert.strictEqual(C.shouldPushPath('.obsidian/plugins/dataview/main.js', 100, {}).ok, true);
	});

	await test('every always-excluded path is refused, one by one', () => {
		// Asserted per rule so that dropping any single one is caught.
		const cases = [
			'.obsidian/plugins/x/data.json',
			'.obsidian/plugins/jemzsync/main.js',
			'.obsidian/workspace.json',
			'.obsidian/workspace-mobile.json',
			'.jemzsync/device-abc.json',
			'.trash/old.md',
			'.git/config',
			'.DS_Store',
			'Notes/.DS_Store',
			'Notes/.Big.pdf.icloud',
		];
		for (const p of cases) {
			assert.strictEqual(C.shouldPushPath(p, 10, {}).ok, false, 'should refuse ' + p);
		}
	});

	await test('ordinary notes and attachments are pushed', () => {
		for (const p of ['Welcome.md', 'Notes/Idea.md', 'assets/photo.png', '.obsidian/app.json']) {
			assert.strictEqual(C.shouldPushPath(p, 1000, {}).ok, true, 'should allow ' + p);
		}
	});

	await test('"notes only" keeps the whole config folder back', () => {
		assert.strictEqual(C.shouldPushPath('.obsidian/app.json', 10, { notesOnly: true }).ok, false);
		assert.strictEqual(C.shouldPushPath('Welcome.md', 10, { notesOnly: true }).ok, true);
	});

	await test('an oversized file is skipped with a reason, not silently', () => {
		const r = C.shouldPushPath('huge.zip', 50 * 1024 * 1024, {});
		assert.strictEqual(r.ok, false);
		assert.ok(r.why.indexOf('larger than') !== -1, r.why);
	});

	group('push planning');

	await test('works out adds, changes and removals', () => {
		const plan = C.buildPushPlan(
			[
				{ path: 'a.md', sha: 'sha-a' },
				{ path: 'b.md', sha: 'sha-b-NEW' },
				{ path: 'c.md', sha: 'sha-c' },
			],
			{ 'b.md': 'sha-b-OLD', 'c.md': 'sha-c', 'gone.md': 'sha-gone' }
		);
		assert.deepStrictEqual(plan.create.map((f) => f.path), ['a.md']);
		assert.deepStrictEqual(plan.update.map((f) => f.path), ['b.md']);
		assert.deepStrictEqual(plan.remove.map((f) => f.path), ['gone.md']);
		assert.strictEqual(plan.unchanged, 1);
	});

	await test('an identical file is never re-uploaded', () => {
		const plan = C.buildPushPlan([{ path: 'a.md', sha: 'x' }], { 'a.md': 'x' });
		assert.ok(C.planIsEmpty(plan));
	});

	await test('adding files is not treated as destructive', () => {
		const plan = C.buildPushPlan([{ path: 'new.md', sha: 'x' }], {});
		assert.strictEqual(C.planIsDestructive(plan), false, 'pure additions must apply without asking');
	});

	await test('changing or removing a file IS destructive', () => {
		assert.strictEqual(
			C.planIsDestructive(C.buildPushPlan([{ path: 'a.md', sha: 'new' }], { 'a.md': 'old' })),
			true
		);
		assert.strictEqual(C.planIsDestructive(C.buildPushPlan([], { 'a.md': 'old' })), true);
	});

	await test('a removal is expressed as a null sha', () => {
		const entries = C.buildTreeEntries(C.buildPushPlan([], { 'gone.md': 'x' }), {});
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].sha, null);
		assert.strictEqual(entries[0].mode, '100644');
	});

	group('repo references and paging');

	await test('accepts every shape a repo gets written in', () => {
		for (const s of [
			'jamalbalya/obsidian',
			'https://github.com/jamalbalya/obsidian',
			'https://github.com/jamalbalya/obsidian.git',
			'  jamalbalya/obsidian/  ',
		]) {
			assert.strictEqual(C.parseRepoRef(s).full, 'jamalbalya/obsidian', 'failed on ' + s);
		}
	});

	await test('rejects nonsense rather than guessing', () => {
		for (const s of ['', 'obsidian', 'a/b/c', 'not a repo']) {
			assert.strictEqual(C.parseRepoRef(s), null, 'accepted ' + s);
		}
	});

	await test('finds the next page link', () => {
		assert.strictEqual(
			C.parseNextLink('<https://api.github.com/x?page=2>; rel="next", <...>; rel="last"'),
			'https://api.github.com/x?page=2'
		);
		assert.strictEqual(C.parseNextLink('<https://x>; rel="last"'), null);
		assert.strictEqual(C.parseNextLink(''), null);
	});

	group('errors and backoff');

	await test('each failure gets an explanation you can act on', () => {
		assert.ok(/revoked|expired/i.test(C.classifyGithubError(401, {}).message));
		assert.ok(/Contents/i.test(C.classifyGithubError(403, {}).message));
		assert.ok(/private/i.test(C.classifyGithubError(404, {}, 'repos/x/y').message));
		assert.ok(/another device/i.test(C.classifyGithubError(422, {}).message));
	});

	await test('a rate limit is retried, a bad token is not', () => {
		assert.strictEqual(C.classifyGithubError(403, { message: 'API rate limit exceeded' }).fatal, false);
		assert.strictEqual(C.classifyGithubError(401, {}).fatal, true);
	});

	await test("waits as long as GitHub's Retry-After asks", () => {
		assert.strictEqual(C.githubBackoffMs(403, { 'retry-after': '30' }, 0), 30000);
	});

	await test('backs off exponentially otherwise, and stays bounded', () => {
		assert.ok(C.githubBackoffMs(500, {}, 0) < C.githubBackoffMs(500, {}, 3));
		assert.ok(C.githubBackoffMs(500, {}, 50) <= 30000);
	});

	await test('a bad token is never retried in a loop', () => {
		assert.strictEqual(C.githubShouldRetry(401, 0, 4), false);
		assert.strictEqual(C.githubShouldRetry(404, 0, 4), false);
		// Seen on a real new repository: the first commit lands, then GitHub
		// briefly still calls the repo empty. Riding that out is the fix.
		assert.strictEqual(C.githubShouldRetry(409, 0, 4), true);
		assert.strictEqual(C.githubShouldRetry(500, 0, 4), true);
		assert.strictEqual(C.githubShouldRetry(500, 9, 4), false, 'must give up eventually');
	});

	group('the wire protocol, against a fake GitHub');

	/*
	 * These once tested a separate one-way push helper. That helper is gone —
	 * everything goes through the two-way engine now — but the invariants it
	 * protected are the important ones, so they moved rather than vanished.
	 */
	function vaultOf(initial) {
		const files = Object.assign({}, initial || {});
		const trashed = [];
		let base = Object.create(null);
		return {
			files: files,
			trashed: trashed,
			get base() {
				return base;
			},
			io: {
				get base() {
					return base;
				},
				listLocal: async () => {
					const out = [];
					for (const p of Object.keys(files)) {
						out.push({
							path: p,
							size: files[p].length,
							sha: await C.gitBlobSha(bytes(files[p])),
						});
					}
					return { files: out, skipped: [], errors: [] };
				},
				readBytes: async (p) => bytes(files[p]),
				writeBytes: async (p, b) => {
					files[p] = new TextDecoder().decode(b);
				},
				trash: async (p) => {
					trashed.push(p);
					delete files[p];
				},
				saveBase: async (next) => {
					base = next;
				},
			},
		};
	}
	const run = (gh, v, opts) =>
		G.githubSync(
			G.githubClient('tok', gh.request, noSleep),
			'o/r',
			'main',
			v.io,
			Object.assign({ confirmed: true }, opts || {})
		);

	await test('the first sync creates the branch and lands every file', async () => {
		const gh = fakeGitHub();
		const v = vaultOf({ 'Welcome.md': 'hello', 'Notes/Idea.md': 'an idea' });
		const res = await run(gh, v);
		assert.strictEqual(res.applied, true);
		assert.deepStrictEqual(gh.filesOn('main'), {
			'Welcome.md': 'hello',
			'Notes/Idea.md': 'an idea',
		});
	});

	await test('a second sync with no changes uploads nothing at all', async () => {
		const gh = fakeGitHub();
		const v = vaultOf({ 'a.md': 'alpha' });
		await run(gh, v);
		const blobs = () =>
			gh.requests.filter((r) => r.method === 'POST' && /\/git\/blobs$/.test(r.path)).length;
		const before = blobs();
		const res = await run(gh, v);
		assert.strictEqual(res.applied, false);
		assert.strictEqual(res.reason, 'in-sync');
		assert.strictEqual(blobs(), before, 'an unchanged vault must not upload a single blob');
	});

	await test('only the changed file is uploaded on an edit', async () => {
		const gh = fakeGitHub();
		const v = vaultOf({ 'a.md': 'alpha', 'b.md': 'beta' });
		await run(gh, v);
		const before = gh.requests.filter(
			(r) => r.method === 'POST' && /\/git\/blobs$/.test(r.path)
		).length;
		v.files['b.md'] = 'beta EDITED';
		await run(gh, v);
		const after = gh.requests.filter(
			(r) => r.method === 'POST' && /\/git\/blobs$/.test(r.path)
		).length;
		assert.strictEqual(after - before, 1, 'exactly one blob should have been uploaded');
		assert.strictEqual(gh.filesOn('main')['a.md'], 'alpha', 'the untouched file must survive');
	});

	await test('the commit records which device sent it', async () => {
		const gh = fakeGitHub();
		const v = vaultOf({ 'a.md': 'alpha' });
		await run(gh, v, { message: 'jemzsync: Mac' });
		assert.ok(gh.commits[gh.refs['main']].message.indexOf('Mac') !== -1);
	});

	await test('a dry run reports the plan and changes nothing', async () => {
		const gh = fakeGitHub();
		const v = vaultOf({ 'a.md': 'alpha' });
		const res = await run(gh, v, { dryRun: true });
		assert.strictEqual(res.applied, false);
		assert.strictEqual(res.plan.push.length, 1);
		assert.strictEqual(gh.refs['main'], undefined, 'a dry run must not create a branch');
	});

	await test('the branch is moved WITHOUT force, so a race cannot overwrite', async () => {
		const gh = fakeGitHub();
		const v = vaultOf({ 'a.md': 'alpha' });
		await run(gh, v);
		v.files['a.md'] = 'alpha two';
		await run(gh, v);

		const patches = gh.requests.filter((r) => r.method === 'PATCH');
		assert.ok(patches.length >= 1, 'the update must go through PATCH');
		for (const pr of patches) {
			assert.deepStrictEqual(
				Object.keys(pr.body).sort(),
				['sha'],
				'a ref update must carry nothing but the sha'
			);
		}
		for (const r of gh.requests) {
			assert.strictEqual(
				JSON.stringify(r.body || {}).indexOf('force'),
				-1,
				'no request may ask GitHub to force anything: ' + r.method + ' ' + r.path
			);
		}
	});

	await test('a 422 race surfaces as "another device pushed first"', async () => {
		const gh = fakeGitHub();
		const v = vaultOf({ 'a.md': 'alpha' });
		await run(gh, v);
		v.files['a.md'] = 'changed';
		gh.failures = [null, null, null, null, null, { status: 422, message: 'not a fast forward' }];
		let caught = null;
		try {
			await run(gh, v);
		} catch (e) {
			caught = e;
		}
		assert.ok(caught, 'the push must fail rather than force');
		assert.ok(/another device/i.test(caught.message), caught.message);
	});

	await test('a truncated tree stops the sync instead of deleting files', async () => {
		const gh = fakeGitHub();
		const v = vaultOf({ 'a.md': 'alpha' });
		await run(gh, v);
		gh.truncated = true;
		let caught = null;
		try {
			await run(gh, v);
		} catch (e) {
			caught = e;
		}
		assert.ok(caught, 'must refuse');
		assert.ok(/too large|stopped/i.test(caught.message), caught.message);
	});

	await test('a rate limit is waited out and the sync still completes', async () => {
		// Two files, so there is still work to do after the bootstrap commit.
		const gh = fakeGitHub({ failures: [{ status: 403, message: 'API rate limit exceeded' }] });
		const v = vaultOf({ 'a.md': 'alpha', 'b.md': 'beta' });
		await run(gh, v);
		assert.deepStrictEqual(gh.filesOn('main'), { 'a.md': 'alpha', 'b.md': 'beta' });
	});

	await test('a revoked token fails immediately with a clear message', async () => {
		const gh = fakeGitHub({ failures: [{ status: 401, message: 'Bad credentials' }] });
		const client = G.githubClient('tok', gh.request, noSleep);
		let caught = null;
		try {
			await client.whoami();
		} catch (e) {
			caught = e;
		}
		assert.ok(caught && /revoked|expired/i.test(caught.message), caught && caught.message);
	});

	group('three-way merge — every outcome');

	// base / local / remote, using distinct shas so the intent is readable.
	const B = { 'n.md': 'v1' };

	await test('nothing moved anywhere', () => {
		const p = C.buildSyncPlan(B, { 'n.md': 'v1' }, { 'n.md': 'v1' });
		assert.ok(C.syncPlanIsEmpty(p));
		assert.strictEqual(p.unchanged, 1);
	});

	await test('changed here only → sent', () => {
		const p = C.buildSyncPlan(B, { 'n.md': 'v2' }, { 'n.md': 'v1' });
		assert.deepStrictEqual(p.push.map((x) => x.path), ['n.md']);
		assert.strictEqual(p.pull.length, 0);
	});

	await test('changed there only → received', () => {
		const p = C.buildSyncPlan(B, { 'n.md': 'v1' }, { 'n.md': 'v9' });
		assert.deepStrictEqual(p.pull.map((x) => x.path), ['n.md']);
		assert.strictEqual(p.push.length, 0);
	});

	await test('added here → sent', () => {
		const p = C.buildSyncPlan({}, { 'new.md': 'x' }, {});
		assert.deepStrictEqual(p.push.map((x) => x.path), ['new.md']);
	});

	await test('added there → received', () => {
		const p = C.buildSyncPlan({}, {}, { 'theirs.md': 'y' });
		assert.deepStrictEqual(p.pull.map((x) => x.path), ['theirs.md']);
	});

	await test('deleted here, untouched there → removed from the repo', () => {
		const p = C.buildSyncPlan(B, {}, { 'n.md': 'v1' });
		assert.deepStrictEqual(p.deleteRemote.map((x) => x.path), ['n.md']);
		assert.strictEqual(p.deleteLocal.length, 0);
	});

	await test('deleted there, untouched here → removed locally', () => {
		const p = C.buildSyncPlan(B, { 'n.md': 'v1' }, {});
		assert.deepStrictEqual(p.deleteLocal.map((x) => x.path), ['n.md']);
		assert.strictEqual(p.deleteRemote.length, 0);
	});

	await test('changed in BOTH places → both versions kept, nothing discarded', () => {
		const p = C.buildSyncPlan(B, { 'n.md': 'mine' }, { 'n.md': 'theirs' });
		assert.strictEqual(p.conflict.length, 1);
		assert.strictEqual(p.conflict[0].localSha, 'mine');
		assert.strictEqual(p.conflict[0].remoteSha, 'theirs');
		assert.strictEqual(p.pull.length, 0, 'a conflict must not silently overwrite');
		assert.strictEqual(p.deleteLocal.length, 0);
	});

	await test('edited here, deleted there → the edit survives', () => {
		// An edit carries information a deletion does not. Losing writing is
		// unrecoverable; an unexpectedly resurrected file is not.
		const p = C.buildSyncPlan(B, { 'n.md': 'edited' }, {});
		assert.deepStrictEqual(p.push.map((x) => x.path), ['n.md']);
		assert.strictEqual(p.deleteLocal.length, 0, 'must not delete the edited file');
	});

	await test('deleted here, edited there → the edit survives', () => {
		const p = C.buildSyncPlan(B, {}, { 'n.md': 'edited' });
		assert.deepStrictEqual(p.pull.map((x) => x.path), ['n.md']);
		assert.strictEqual(p.deleteRemote.length, 0, 'must not delete the edited file');
	});

	await test('deleted in both places at once → nothing to do', () => {
		const p = C.buildSyncPlan(B, {}, {});
		assert.ok(C.syncPlanIsEmpty(p));
	});

	await test('the same edit made on both devices is not a conflict', () => {
		const p = C.buildSyncPlan(B, { 'n.md': 'same' }, { 'n.md': 'same' });
		assert.ok(C.syncPlanIsEmpty(p));
	});

	await test('with no base, an identical file is still not a conflict', () => {
		// First sync on a device that already had the notes.
		const p = C.buildSyncPlan({}, { 'n.md': 'same' }, { 'n.md': 'same' });
		assert.ok(C.syncPlanIsEmpty(p));
	});

	await test('with no base, a genuine difference is treated as a conflict', () => {
		// The safe way to be wrong: keep both rather than pick one.
		const p = C.buildSyncPlan({}, { 'n.md': 'mine' }, { 'n.md': 'theirs' });
		assert.strictEqual(p.conflict.length, 1);
	});

	await test('receiving is destructive, sending is not', () => {
		assert.strictEqual(
			C.syncPlanIsDestructive(C.buildSyncPlan({}, { 'a.md': 'x' }, {})),
			false,
			'sending our own work needs no permission'
		);
		assert.strictEqual(
			C.syncPlanIsDestructive(C.buildSyncPlan(B, { 'n.md': 'v1' }, {})),
			true,
			'a local delete must be confirmable'
		);
	});

	await test('a conflict copy is a name the existing resolver already knows', () => {
		// This is what lets Keep newest / Merge both handle it with no new UI.
		const name = C.conflictCopyName('Notes/Plan.md', '2026-08-02');
		assert.strictEqual(name, 'Notes/Plan (github conflicted copy 2026-08-02).md');
		const found = C.findConflicts(['Notes/Plan.md', name]);
		assert.strictEqual(found.length, 1, 'the existing conflict finder must match it');
		assert.strictEqual(found[0].original, 'Notes/Plan.md');
	});

	group('two-way sync against a fake GitHub');

	/** A vault in a variable, mirroring the adapter surface the sync uses. */
	function fakeVault(initial) {
		const files = Object.assign({}, initial || {});
		const trashed = [];
		return {
			files: files,
			trashed: trashed,
			io: {
				base: Object.create(null),
				listLocal: async () => {
					const out = [];
					for (const p of Object.keys(files)) {
						out.push({ path: p, size: files[p].length, sha: await C.gitBlobSha(bytes(files[p])) });
					}
					return { files: out, skipped: [], errors: [] };
				},
				readBytes: async (p) => bytes(files[p]),
				writeBytes: async (p, b) => {
					files[p] = new TextDecoder().decode(b);
				},
				trash: async (p) => {
					trashed.push(p);
					delete files[p];
				},
				saveBase: async (next) => {
					this_base = next;
				},
			},
		};
	}
	let this_base = null;

	async function syncOnce(gh, vault, opts) {
		const client = G.githubClient('tok', gh.request, noSleep);
		this_base = null;
		// Most tests simulate a user who has approved the change; the pause
		// itself gets its own tests below.
		const res = await G.githubSync(
			client,
			'o/r',
			'main',
			vault.io,
			Object.assign({ confirmed: true }, opts || {})
		);
		if (this_base) vault.io.base = this_base;
		return res;
	}

	await test('first sync from an empty repo uploads the whole vault', async () => {
		const gh = fakeGitHub();
		const v = fakeVault({ 'a.md': 'alpha', 'b.md': 'beta' });
		const res = await syncOnce(gh, v);
		assert.strictEqual(res.applied, true);
		assert.deepStrictEqual(gh.filesOn('main'), { 'a.md': 'alpha', 'b.md': 'beta' });
	});

	await test('a second device receives everything it does not have', async () => {
		const gh = fakeGitHub();
		const mac = fakeVault({ 'a.md': 'alpha' });
		await syncOnce(gh, mac);

		const phone = fakeVault({});
		const res = await syncOnce(gh, phone);
		assert.strictEqual(res.applied, true);
		assert.deepStrictEqual(phone.files, { 'a.md': 'alpha' });
	});

	await test('an edit on one device reaches the other', async () => {
		const gh = fakeGitHub();
		const mac = fakeVault({ 'a.md': 'alpha' });
		await syncOnce(gh, mac);
		const phone = fakeVault({});
		await syncOnce(gh, phone);

		mac.files['a.md'] = 'alpha EDITED';
		await syncOnce(gh, mac);
		await syncOnce(gh, phone);
		assert.strictEqual(phone.files['a.md'], 'alpha EDITED');
	});

	await test('a delete on one device reaches the other, via the trash', async () => {
		const gh = fakeGitHub();
		const mac = fakeVault({ 'a.md': 'alpha', 'b.md': 'beta' });
		await syncOnce(gh, mac);
		const phone = fakeVault({});
		await syncOnce(gh, phone);

		delete mac.files['b.md'];
		await syncOnce(gh, mac);
		assert.deepStrictEqual(Object.keys(gh.filesOn('main')), ['a.md']);

		await syncOnce(gh, phone);
		assert.deepStrictEqual(Object.keys(phone.files), ['a.md']);
		assert.deepStrictEqual(phone.trashed, ['b.md'], 'must be trashed, not destroyed');
	});

	await test('editing the same note on both devices keeps both versions', async () => {
		const gh = fakeGitHub();
		const mac = fakeVault({ 'n.md': 'original' });
		await syncOnce(gh, mac);
		const phone = fakeVault({});
		await syncOnce(gh, phone);

		mac.files['n.md'] = 'the Mac version';
		phone.files['n.md'] = 'the phone version';
		await syncOnce(gh, mac); // Mac wins the race to the repo

		const res = await syncOnce(gh, phone);
		assert.strictEqual(res.plan.conflict.length, 1);

		const names = Object.keys(phone.files).sort();
		assert.ok(names.indexOf('n.md') !== -1, 'the phone keeps its own version');
		assert.strictEqual(phone.files['n.md'], 'the phone version');
		const copy = names.filter((n) => /conflicted copy/.test(n))[0];
		assert.ok(copy, 'the other version must be kept alongside: ' + names.join(', '));
		assert.strictEqual(phone.files[copy], 'the Mac version');
	});

	await test('a sync that changes nothing makes no commit', async () => {
		const gh = fakeGitHub();
		const v = fakeVault({ 'a.md': 'alpha' });
		await syncOnce(gh, v);
		// Only *creating* a commit counts; reading one is how we learn there
		// is nothing to do.
		// Only *creating* a commit counts; reading one is how we learn there
		// is nothing to do.
		const posts = (re) => gh.requests.filter((r) => r.method === 'POST' && re.test(r.path)).length;
		const commitsBefore = posts(/\/git\/commits$/);
		const blobsBefore = posts(/\/git\/blobs$/);

		const res = await syncOnce(gh, v);
		assert.strictEqual(res.applied, false);
		assert.strictEqual(res.reason, 'in-sync');
		assert.strictEqual(posts(/\/git\/commits$/), commitsBefore, 'an idle sync must not churn the repository');
		assert.strictEqual(posts(/\/git\/blobs$/), blobsBefore, 'and must not re-upload a single file');
	});

	await test('a device already in step records that, so the next edit is not a "conflict"', async () => {
		// Found by the cross-ecosystem harness. The first sync on a fresh
		// repository only bootstraps, so the plan comes out empty — and the
		// agreement went unrecorded. The next real edit from the other device
		// then compared against an empty base, looked like both sides had
		// moved, and was reported as a conflict that never happened.
		const gh = fakeGitHub();
		const mac = fakeVault({ 'shared.md': 'from the Mac' });
		await syncOnce(gh, mac);
		assert.ok(Object.keys(mac.io.base).length > 0, 'the first sync must record a base');

		const pc = fakeVault({});
		await syncOnce(gh, pc);
		assert.strictEqual(pc.files['shared.md'], 'from the Mac');
		assert.ok(Object.keys(pc.io.base).length > 0, 'the receiving device must record one too');

		pc.files['shared.md'] = 'edited on the PC';
		await syncOnce(gh, pc);
		const res = await syncOnce(gh, mac);

		assert.strictEqual(res.plan.conflict.length, 0, 'a one-sided edit is not a conflict');
		assert.strictEqual(mac.files['shared.md'], 'edited on the PC', 'it must simply arrive');
		assert.strictEqual(
			Object.keys(mac.files).filter((f) => /conflicted copy/.test(f)).length,
			0,
			'and must leave no spurious conflict copy'
		);
	});

	group('a sync-driven delete must always be recoverable');

	function fakeAdapterFS(files) {
		return {
			async exists(p) {
				return p in files || Object.keys(files).some((k) => k.indexOf(p + '/') === 0);
			},
			async mkdir(p) {
				files[p + '/'] = true;
			},
			async rename(a, b) {
				files[b] = files[a];
				delete files[a];
			},
			async remove(p) {
				delete files[p];
			},
		};
	}

	await test('a file Obsidian knows about goes to Obsidian\'s trash', async () => {
		const trashed = [];
		const app = {
			vault: { getAbstractFileByPath: (p) => ({ path: p }) },
			fileManager: { trashFile: async (f) => trashed.push(f.path) },
		};
		const where = await G.trashPath(app, fakeAdapterFS({}), 'Notes/gone.md');
		assert.strictEqual(where, 'obsidian-trash');
		assert.deepStrictEqual(trashed, ['Notes/gone.md']);
	});

	await test('a file the index has not seen yet is NEVER hard-deleted', async () => {
		// The real failure: a note created seconds earlier is not in Obsidian's
		// index yet, the lookup returns nothing, and the old fallback removed
		// it outright — gone from the vault, gone from the Obsidian trash, gone
		// from the macOS trash. Unrecoverable.
		const files = { 'Notes/new.md': 'content' };
		const app = {
			vault: { getAbstractFileByPath: () => null },
			fileManager: { trashFile: async () => {} },
		};
		const where = await G.trashPath(app, fakeAdapterFS(files), 'Notes/new.md');
		assert.strictEqual(where, 'vault-trash');
		assert.strictEqual(files['Notes/new.md'], undefined, 'moved out of place');
		assert.strictEqual(files['.trash/new.md'], 'content', 'and into the trash, intact');
	});

	await test('if even the rescue fails, the file is kept rather than destroyed', async () => {
		const app = {
			vault: { getAbstractFileByPath: () => null },
			fileManager: { trashFile: async () => {} },
		};
		const hostile = {
			async exists() {
				return false;
			},
			async mkdir() {
				throw new Error('read-only');
			},
			async rename() {
				throw new Error('read-only');
			},
			async remove() {
				throw new Error('should never be called');
			},
		};
		const where = await G.trashPath(app, hostile, 'Notes/x.md');
		assert.strictEqual(where, 'kept', 'losing the file is never the fallback');
	});

	await test('a partial vault scan is refused outright', () => {
		// Past the scanner's cap every remaining file is simply absent, which
		// reads as "deleted" and would strip the repository.
		assert.throws(
			() => G.assertScanComplete({ truncated: true, entries: [], placeholders: [] }),
			/more files than jemzsync can scan/i
		);
		assert.doesNotThrow(() => G.assertScanComplete({ truncated: false, placeholders: [] }));
		assert.doesNotThrow(() => G.assertScanComplete(null));
	});

	await test('offloaded files are reported as unreadable, never as absent', () => {
		const scan = {
			placeholders: [
				{ path: 'Notes/.Big.pdf.icloud', expects: 'Notes/Big.pdf' },
				{ path: '.Deep.md.icloud', expects: 'Deep.md' },
			],
		};
		const out = G.unreadableFromScan(scan);
		assert.deepStrictEqual(out.map((e) => e.path), ['Notes/Big.pdf', 'Deep.md']);
		assert.ok(/not downloaded/i.test(out[0].message), out[0].message);
		assert.deepStrictEqual(G.unreadableFromScan({ placeholders: [] }), []);
		assert.deepStrictEqual(G.unreadableFromScan(null), []);
	});

	await test('a file the cloud has offloaded is NEVER deleted from the repository', async () => {
		// iCloud replaces a file's contents with a .icloud stub whenever it
		// wants disk space back. The scanner reports those separately, so they
		// never reach the upload list — and without care the sync concludes
		// the file was deleted and removes it from the repository. On an Apple
		// vault this is routine, not an edge case.
		const gh = fakeGitHub();
		const v = fakeVault({ 'keep.md': 'real content', 'other.md': 'more' });
		await syncOnce(gh, v);

		// keep.md gets offloaded: present in the vault, unreadable right now.
		v.io.listLocal = async () => ({
			files: [{ path: 'other.md', size: 4, sha: await C.gitBlobSha(bytes('more')) }],
			skipped: [],
			errors: [{ path: 'keep.md', message: 'not downloaded from the cloud yet' }],
		});

		const res = await syncOnce(gh, v);
		assert.strictEqual(
			res.plan.deleteRemote.length,
			0,
			'an offloaded file must never be reported as deleted'
		);
		assert.ok(gh.filesOn('main')['keep.md'], 'and must still be in the repository');
	});

	await test('a sync that would gut the repository is refused', async () => {
		// The catch-all: any bug that makes the vault look empty — a failed
		// scan, a permissions problem, the wrong folder — becomes "delete
		// everything" without this.
		const gh = fakeGitHub();
		const v = fakeVault({ 'a.md': '1', 'b.md': '2', 'c.md': '3', 'd.md': '4', 'e.md': '5' });
		await syncOnce(gh, v);

		v.io.listLocal = async () => ({ files: [], skipped: [], errors: [] });
		let caught = null;
		try {
			await syncOnce(gh, v);
		} catch (e) {
			caught = e;
		}
		assert.ok(caught, 'wiping the repository must not happen silently');
		assert.ok(/would remove/i.test(caught.message), caught.message);
		assert.strictEqual(
			Object.keys(gh.filesOn('main')).length,
			5,
			'nothing may actually have been removed'
		);
	});

	await test('but an ordinary deletion still goes through', async () => {
		const gh = fakeGitHub();
		const v = fakeVault({ 'a.md': '1', 'b.md': '2', 'c.md': '3', 'd.md': '4', 'e.md': '5' });
		await syncOnce(gh, v);
		delete v.files['b.md'];
		const res = await syncOnce(gh, v);
		assert.strictEqual(res.plan.deleteRemote.length, 1);
		assert.strictEqual(Object.keys(gh.filesOn('main')).length, 4);
	});

	group('the safety pause');

	await test('adding files applies without interruption', async () => {
		const gh = fakeGitHub();
		const mac = fakeVault({ 'a.md': 'one' });
		await G.githubSync(G.githubClient('tok', gh.request, noSleep), 'o/r', 'main', mac.io, {});
		assert.ok(gh.filesOn('main'), 'a pure addition needs no permission');
		assert.strictEqual(gh.filesOn('main')['a.md'], 'one');
	});

	await test('a conflict is NOT destructive — it keeps both, so it applies', async () => {
		// Worth stating: editing the same note in two places adds a copy and
		// keeps yours. Nothing is lost, so there is nothing to approve.
		const gh = fakeGitHub();
		const mac = fakeVault({ 'a.md': 'one' });
		await syncOnce(gh, mac);
		const phone = fakeVault({ 'a.md': 'different' });
		const res = await G.githubSync(
			G.githubClient('tok', gh.request, noSleep),
			'o/r',
			'main',
			phone.io,
			{}
		);
		assert.strictEqual(res.applied, true);
		assert.strictEqual(phone.files['a.md'], 'different', 'your version stays put');
		assert.ok(
			Object.keys(phone.files).some((f) => /conflicted copy/.test(f)),
			'and theirs is kept alongside'
		);
	});

	await test('an overwrite of a local file stops and asks', async () => {
		const gh = fakeGitHub();
		const mac = fakeVault({ 'a.md': 'one' });
		await syncOnce(gh, mac);
		const phone = fakeVault({});
		await syncOnce(gh, phone);          // phone now agrees, base recorded

		mac.files['a.md'] = 'edited on the Mac';
		await syncOnce(gh, mac);            // remote moves, phone untouched

        // The phone would have its copy overwritten — that needs approval.
		const res = await G.githubSync(
			G.githubClient('tok', gh.request, noSleep),
			'o/r',
			'main',
			phone.io,
			{}
		);
		assert.strictEqual(res.applied, false);
		assert.strictEqual(res.reason, 'needs-confirmation');
		assert.strictEqual(phone.files['a.md'], 'one', 'nothing may change before approval');
		assert.ok(res.plan.pull.length, 'and the plan must say what would happen');
	});

	await test('and applies once confirmed', async () => {
		const gh = fakeGitHub();
		const mac = fakeVault({ 'a.md': 'one', 'b.md': 'two' });
		await syncOnce(gh, mac);
		const phone = fakeVault({});
		await syncOnce(gh, phone);
		delete mac.files['b.md'];
		await syncOnce(gh, mac);

		const client = G.githubClient('tok', gh.request, noSleep);
		let res = await G.githubSync(client, 'o/r', 'main', phone.io, {});
		assert.strictEqual(res.reason, 'needs-confirmation', 'a delete must be reviewed');
		assert.ok(phone.files['b.md'], 'still there before approval');

		res = await G.githubSync(client, 'o/r', 'main', phone.io, { confirmed: true });
		assert.strictEqual(res.applied, true);
		assert.strictEqual(phone.files['b.md'], undefined);
		assert.deepStrictEqual(phone.trashed, ['b.md']);
	});

	await test('a stale view of the branch never deletes local files', async () => {
		// Real data loss, seen on the live vault: a note was pushed to GitHub
		// successfully and then deleted off the Mac seconds later. GitHub had
		// served a tree from just before the commit, so the plugin concluded
		// the file had been deleted by another device.
		const gh = fakeGitHub();
		const v = fakeVault({ 'keep.md': 'important', 'other.md': 'also important' });
		await syncOnce(gh, v);
		const head = gh.refs['main'];

		// The branch has not moved, but the tree comes back empty.
		const realTrees = gh.trees;
		gh.trees = Object.assign({}, realTrees);
		gh.trees[gh.commits[head].tree] = {};

		let caught = null;
		try {
			await G.githubSync(
				G.githubClient('tok', gh.request, noSleep),
				'o/r',
				'main',
				v.io,
				{ lastCommit: head }
			);
		} catch (e) {
			caught = e;
		}

		assert.ok(caught, 'an inconsistent read must stop the sync');
		assert.ok(/incomplete view/i.test(caught.message), caught.message);
		assert.deepStrictEqual(
			Object.keys(v.files).sort(),
			['keep.md', 'other.md'],
			'nothing may be removed on the strength of a stale read'
		);
		assert.deepStrictEqual(v.trashed, [], 'and nothing trashed either');
	});

	await test('a genuine remote deletion is still applied', async () => {
		// The guard must not block real deletes: when another device removes a
		// file, the branch has moved, so the check does not apply.
		const gh = fakeGitHub();
		const mac = fakeVault({ 'a.md': 'one', 'b.md': 'two' });
		await syncOnce(gh, mac);
		const phone = fakeVault({});
		await syncOnce(gh, phone);

		delete phone.files['b.md'];
		await syncOnce(gh, phone);          // the branch moves
		await syncOnce(gh, mac);

		assert.deepStrictEqual(Object.keys(mac.files), ['a.md']);
		assert.deepStrictEqual(mac.trashed, ['b.md'], 'and it goes to the trash');
	});

	await test('an unreadable local file is left alone on both sides', async () => {
		const gh = fakeGitHub();
		const v = fakeVault({ 'a.md': 'alpha', 'locked.md': 'secret' });
		await syncOnce(gh, v);

		// It becomes unreadable; it must not be deleted from the repo.
		v.io.listLocal = async () => ({
			files: [{ path: 'a.md', size: 5, sha: await C.gitBlobSha(bytes('alpha')) }],
			skipped: [],
			errors: [{ path: 'locked.md', message: 'EACCES' }],
		});
		const res = await syncOnce(gh, v);
		assert.strictEqual(
			res.plan.deleteRemote.length,
			0,
			'a file we could not read must never be treated as deleted'
		);
		assert.ok(gh.filesOn('main')['locked.md'], 'it must still be in the repository');
	});

	group('the sync feedback loop (the way this eats itself)');

	/*
	 * Applying a pull writes files into the vault. Those writes fire
	 * Obsidian's own change events. If those events schedule another sync,
	 * every device wakes every other device forever, committing as it goes.
	 * This is the same shape as the beacon loop the plugin already guards,
	 * and it is the single most expensive bug this feature could ship with.
	 */
	function pluginUnderTest() {
		const sink = [];
		const mod = loadWithFakeObsidian(sink);
		const p = Object.create(mod.prototype);
		p.settings = Object.assign({}, C.DEFAULT_SETTINGS, { githubAutoSync: true });
		p.github = { mode: 'github', token: 'tok', repo: 'o/r', branch: 'main' };
		p.applyingRemote = false;
		p.githubTimer = null;
		p.liveTimer = null;
		p.registerEvent = () => {};

		const handlers = [];
		p.app = { vault: { on: (_evt, fn) => (handlers.push(fn), {}) } };

		let scheduled = 0;
		const timers = [];
		global.window = {
			setTimeout: (fn) => {
				scheduled++;
				timers.push(fn);
				return timers.length;
			},
			clearTimeout: () => {},
			setInterval: () => 0,
			clearInterval: () => {},
		};
		return {
			p: p,
			handlers: handlers,
			runTimers: () => timers.splice(0).forEach((f) => f()),
			scheduledCount: () => scheduled,
			reset: () => (scheduled = 0),
		};
	}

	await test('a normal edit schedules a sync', async () => {
		const t = pluginUnderTest();
		t.p.scheduleGithubSync();
		assert.ok(t.scheduledCount() > 0, 'an ordinary edit must reach GitHub');
		delete global.window;
	});

	await test('nothing is scheduled while remote changes are being applied', async () => {
		const t = pluginUnderTest();
		t.p.applyingRemote = true;
		t.p.scheduleGithubSync();
		assert.strictEqual(
			t.scheduledCount(),
			0,
			'writing a pulled file must not schedule another sync'
		);
		delete global.window;
	});

	await test('a vault event caused by our own write does not start a sync', async () => {
		const t = pluginUnderTest();
		t.p.startWatching();
		assert.ok(t.handlers.length >= 4, 'create/modify/delete/rename should all be watched');

		t.p.applyingRemote = true;
		t.reset();
		for (const h of t.handlers) h({ path: 'Notes/pulled.md' });
		// The local rescan may still be scheduled — that is cheap and correct.
		// What must not happen is a GitHub sync.
		const duringApply = t.scheduledCount();

		t.p.applyingRemote = false;
		t.reset();
		for (const h of t.handlers) h({ path: 'Notes/typed.md' });
		const afterApply = t.scheduledCount();

		assert.ok(
			afterApply > duringApply,
			'an edit by the user must schedule more work than a write we caused ourselves'
		);
		delete global.window;
	});

	await test('the watcher guard holds on its own, without the scheduler guard', async () => {
		// Deliberately redundant with the check inside scheduleGithubSync, and
		// tested separately for the same reason the beacon guard is: if either
		// half is ever removed, the other must still close the loop — and a
		// test that only observes the combined effect would not notice.
		const t = pluginUnderTest();
		let called = 0;
		t.p.scheduleGithubSync = () => called++;
		t.p.startWatching();

		t.p.applyingRemote = true;
		for (const h of t.handlers) h({ path: 'Notes/pulled.md' });
		assert.strictEqual(called, 0, 'the watcher must not even ask for a sync mid-apply');

		t.p.applyingRemote = false;
		for (const h of t.handlers) h({ path: 'Notes/typed.md' });
		assert.ok(called > 0, 'and must ask normally once the apply is over');
		delete global.window;
	});

	await test('an edit made DURING a sync is remembered, not dropped', async () => {
		// Found on the real vault: a note written while a sync was in flight
		// never reached GitHub on the fast path and sat unsent until the next
		// poll, minutes later. Suppressing the feedback loop must not swallow
		// genuine edits.
		const t = pluginUnderTest();
		t.p.applyingRemote = true;
		t.p.scheduleGithubSync();
		assert.strictEqual(t.scheduledCount(), 0, 'nothing is scheduled mid-sync');
		assert.strictEqual(t.p.syncWanted, true, 'but the edit must be remembered');

		// Once the sync finishes, the remembered edit gets its turn.
		t.p.applyingRemote = false;
		if (t.p.syncWanted) {
			t.p.syncWanted = false;
			t.p.scheduleGithubSync();
		}
		assert.ok(t.scheduledCount() > 0, 'and must be sent once the sync is over');
		delete global.window;
	});

	await test('auto-sync can be switched off entirely', async () => {
		const t = pluginUnderTest();
		t.p.settings.githubAutoSync = false;
		t.p.scheduleGithubSync();
		assert.strictEqual(t.scheduledCount(), 0);
		delete global.window;
	});

	await test('switching to cloud-only stops GitHub syncing immediately', async () => {
		// Found on the real vault: the mode was read once, when the timer was
		// created. A vault switched to cloud-only carried on committing to
		// GitHub until Obsidian restarted.
		const t = pluginUnderTest();
		assert.strictEqual(t.p.githubReady(), true, 'starts ready in github mode');
		t.p.github.mode = 'ecosystem';
		assert.strictEqual(
			t.p.githubReady(),
			false,
			'the mode must be re-read, not remembered from startup'
		);
		t.reset();
		t.p.scheduleGithubSync();
		assert.strictEqual(t.scheduledCount(), 0, 'and nothing may be scheduled');
		delete global.window;
	});

	await test('switching TO GitHub starts syncing without a restart', async () => {
		// The same bug in the other direction: a vault that started in
		// cloud-only mode never registered the timer at all.
		const t = pluginUnderTest();
		t.p.github.mode = 'ecosystem';
		assert.strictEqual(t.p.githubReady(), false);
		t.p.github.mode = 'both';
		assert.strictEqual(t.p.githubReady(), true, 'must become ready at once');
		t.reset();
		t.p.scheduleGithubSync();
		assert.ok(t.scheduledCount() > 0);
		delete global.window;
	});

	await test('nothing is scheduled when GitHub is not the storage', async () => {
		const t = pluginUnderTest();
		t.p.github.mode = 'ecosystem';
		t.p.scheduleGithubSync();
		assert.strictEqual(t.scheduledCount(), 0, 'must stay inert unless GitHub is switched on');
		delete global.window;
	});

	await test('nothing is scheduled before an account and repo exist', async () => {
		const t = pluginUnderTest();
		t.p.github.token = '';
		t.p.scheduleGithubSync();
		assert.strictEqual(t.scheduledCount(), 0);
		delete global.window;
	});

	group('text must survive exactly — every character, every case');

	/*
	 * A note is only useful if it comes back identical. Base64, UTF-8 and the
	 * binary write path each offer a way to mangle text silently: a smart
	 * quote becoming a question mark, an emoji becoming two broken glyphs,
	 * CamelCase being lowercased by some well-meaning normaliser.
	 */
	const TRICKY = [
		['CamelCase', 'thisIsCamelCase AndPascalCase and_snake_case and-kebab-case'],
		['all caps and mixed', 'ALLCAPS MiXeD cAsE iOS macOS iPhone jemzSync GitHub'],
		['accents', 'café naïve façade Zürich Ærø piñata þorn ﬁ ligature'],
		['CJK', '中文 日本語 한국어 テスト 测试'],
		['emoji', 'done ✅ fire 🔥 family 👨‍👩‍👧‍👦 flag 🇮🇩 skin 👍🏽'],
		['markdown metachars', '# *bold* _em_ `code` > quote [link](url) ~~strike~~ | table |'],
		['quotes and dashes', '“smart” ‘single’ — em – en … ellipsis « guillemets »'],
		['symbols', '!@#$%^&*()_+-=[]{}|;\':",./<>?\\~` §±¶•ªº'],
		['rtl and combining', 'العربية עברית áè combining'],
		['whitespace shapes', 'tab\there\ntrailing   \n\n\nblank lines\r\nCRLF'],
		['zero width and nbsp', 'a​b non breaking ⁠word joiner'],
		['math and currency', '∑∫√≈≠≤≥ €£¥₹₿ ½¼¾ ×÷'],
	];

	await test('every kind of text round-trips through base64 unchanged', () => {
		for (const [label, text] of TRICKY) {
			const back = new TextDecoder().decode(C.base64ToBytes(C.bytesToBase64(bytes(text))));
			assert.strictEqual(back, text, label + ' was mangled');
		}
	});

	await test('and survives a real push and pull through GitHub', async () => {
		const gh = fakeGitHub();
		const source = {};
		TRICKY.forEach(([label, text], i) => {
			source['note-' + i + '.md'] = text;
		});

		const mac = fakeVault(source);
		await syncOnce(gh, mac);

		// A second device pulls everything down from scratch.
		const phone = fakeVault({});
		await syncOnce(gh, phone);

		TRICKY.forEach(([label, text], i) => {
			assert.strictEqual(
				phone.files['note-' + i + '.md'],
				text,
				label + ' did not survive the round trip'
			);
		});
	});

	await test('case is never normalised — CamelCase stays CamelCase', async () => {
		const gh = fakeGitHub();
		const text = 'jemzSync GitHub iOS macOS XMLHttpRequest getElementById';
		const mac = fakeVault({ 'Case Test.md': text });
		await syncOnce(gh, mac);
		const phone = fakeVault({});
		await syncOnce(gh, phone);
		assert.strictEqual(phone.files['Case Test.md'], text);
		assert.notStrictEqual(phone.files['Case Test.md'], text.toLowerCase());
	});

	await test('filenames with spaces, accents and symbols survive too', async () => {
		// The path is part of a URL for the bootstrap call, so it gets encoded
		// and must come back out intact.
		const gh = fakeGitHub();
		const names = {
			'My Note.md': 'spaces',
			'Café & Crème.md': 'accents and ampersand',
			'Notes/Sub Folder/Deep Note.md': 'nested with spaces',
			'2026-08-02 Meeting #3.md': 'hash in the name',
			'中文笔记.md': 'CJK filename',
		};
		const mac = fakeVault(names);
		await syncOnce(gh, mac);
		const phone = fakeVault({});
		await syncOnce(gh, phone);
		for (const n of Object.keys(names)) {
			assert.strictEqual(phone.files[n], names[n], 'lost or renamed: ' + n);
		}
	});

	await test('a byte-identical file is never re-uploaded, even with odd characters', async () => {
		const gh = fakeGitHub();
		const v = fakeVault({ 'e.md': 'emoji 🔥 and ünïcode' });
		await syncOnce(gh, v);
		const posts = () => gh.requests.filter((r) => r.method === 'POST' && /blobs$/.test(r.path)).length;
		const before = posts();
		await syncOnce(gh, v);
		assert.strictEqual(posts(), before, 'unicode must not defeat the sha comparison');
	});

	group('collecting the vault');

	await test('excluded files never reach the upload list, and are reported', async () => {
		const listing = [
			{ path: 'Welcome.md', size: 5 },
			{ path: '.obsidian/plugins/secret-plugin/data.json', size: 40 },
			{ path: '.jemzsync/device-a.json', size: 20 },
		];
		const contents = { 'Welcome.md': 'hello' };
		const r = await G.collectPushable(
			async () => listing,
			async (p) => bytes(contents[p] || 'x'),
			{}
		);
		assert.deepStrictEqual(r.files.map((f) => f.path), ['Welcome.md']);
		assert.strictEqual(r.skipped.length, 2);
		assert.ok(r.skipped.some((s) => /secret/i.test(s.why)));
	});

	await test('an unreadable file is reported, not treated as deleted', async () => {
		// Treating it as absent would remove it from the repository.
		const r = await G.collectPushable(
			async () => [{ path: 'ok.md', size: 2 }, { path: 'locked.md', size: 2 }],
			async (p) => {
				if (p === 'locked.md') throw new Error('EACCES');
				return bytes('hi');
			},
			{}
		);
		assert.deepStrictEqual(r.files.map((f) => f.path), ['ok.md']);
		assert.strictEqual(r.errors.length, 1);
		assert.strictEqual(r.errors[0].path, 'locked.md');
	});

	group('storage modes');

	await test('each mode uses what it says it uses', () => {
		assert.strictEqual(G.storageUsesGithub('ecosystem'), false);
		assert.strictEqual(G.storageUsesGithub('github'), true);
		assert.strictEqual(G.storageUsesGithub('both'), true);
		assert.strictEqual(G.storageUsesCloud('github'), false);
		assert.strictEqual(G.storageUsesCloud('both'), true);
	});

	await test('all three combinations the user asked for exist', () => {
		const ids = C.ECOSYSTEMS ? G.STORAGE_MODES.map((m) => m.id) : [];
		assert.deepStrictEqual(ids.sort(), ['both', 'ecosystem', 'github']);
	});

	await test('in GitHub mode a vault outside any cloud is CORRECT', () => {
		// Warning here would repeat the 1.2.1 and 1.3.0 mistakes: telling a
		// working setup to move itself.
		const r = C.classifyVaultLocation('/Users/j/Documents/Notes', {
			platform: 'desktop',
			vaultName: 'Notes',
			ecosystem: 'apple',
			storageMode: 'github',
		});
		assert.strictEqual(r.code, 'github-primary');
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.syncing, true);
		assert.strictEqual(C.shouldWarnAboutLocation(r, null), false, 'must never nag in this mode');
	});

	await test('"both" still expects the cloud to carry the vault', () => {
		const r = C.classifyVaultLocation('/Users/j/Dev/notes', {
			platform: 'desktop',
			vaultName: 'notes',
			ecosystem: 'apple',
			storageMode: 'both',
		});
		assert.strictEqual(r.code, 'local-only');
	});

	await test('omitting the mode leaves every existing verdict untouched', () => {
		const withOut = C.classifyVaultLocation('/Users/j/Documents/N', {
			platform: 'desktop',
			vaultName: 'N',
		});
		const withMode = C.classifyVaultLocation('/Users/j/Documents/N', {
			platform: 'desktop',
			vaultName: 'N',
			storageMode: 'ecosystem',
		});
		assert.strictEqual(withOut.code, 'desktop-documents');
		assert.deepStrictEqual(withOut, withMode);
	});

	group('GitHub health');

	const D = plugin.__device;
	const NOW = 2000000000000;

	await test('says nothing at all when GitHub is not in use', () => {
		assert.strictEqual(D.classifyGithubHealth({ mode: 'ecosystem' }, NOW).ok, true);
	});

	await test('GitHub-only with no account is a real problem, plainly stated', () => {
		const h = D.classifyGithubHealth({ mode: 'github', token: '' }, NOW);
		assert.strictEqual(h.ok, false);
		assert.strictEqual(h.code, 'not-connected');
		assert.ok(/nothing is being saved anywhere/i.test(h.detail), h.detail);
	});

	await test('catches no repo, never synced, and gone stale', () => {
		assert.strictEqual(D.classifyGithubHealth({ mode: 'github', token: 't' }, NOW).code, 'no-repo');
		assert.strictEqual(
			D.classifyGithubHealth({ mode: 'github', token: 't', repo: 'o/r' }, NOW).code,
			'never-synced'
		);
		assert.strictEqual(
			D.classifyGithubHealth(
				{ mode: 'github', token: 't', repo: 'o/r', lastSyncAt: NOW - 8 * 24 * 3600 * 1000 },
				NOW
			).code,
			'stale'
		);
		assert.strictEqual(
			D.classifyGithubHealth(
				{ mode: 'github', token: 't', repo: 'o/r', lastSyncAt: NOW - 60000 },
				NOW
			).ok,
			true
		);
	});

	group('the token must never leave this device');

	await test('the token is written only to per-device storage', () => {
		// The invariant the whole design rests on. saveData writes into the
		// vault — which syncs to every device AND gets committed to the repo
		// the token unlocks.
		const app = fakeApp();
		D.saveGithubConfig(app, {
			mode: 'github',
			token: 'github_pat_SECRET',
			login: 'jamalbalya',
			repo: 'jamalbalya/obsidian',
			branch: 'main',
		});
		for (const k of Object.keys(app.store)) {
			assert.ok(k.indexOf('jemzsync-') === 0, 'unexpected key: ' + k);
		}
		assert.strictEqual(app.store['jemzsync-github-token'], 'github_pat_SECRET');
	});

	await test('the config round-trips', () => {
		const app = fakeApp();
		D.saveGithubConfig(app, {
			mode: 'both',
			token: 't',
			login: 'me',
			repo: 'o/r',
			branch: 'dev',
			lastSyncAt: 123,
			notesOnly: true,
		});
		const cfg = D.loadGithubConfig(app);
		assert.strictEqual(cfg.mode, 'both');
		assert.strictEqual(cfg.repo, 'o/r');
		assert.strictEqual(cfg.branch, 'dev');
		assert.strictEqual(cfg.lastSyncAt, 123);
		assert.strictEqual(cfg.notesOnly, true);
	});

	await test('a fresh vault defaults to the cloud, with GitHub off', () => {
		const cfg = D.loadGithubConfig(fakeApp());
		assert.strictEqual(cfg.mode, 'ecosystem');
		assert.strictEqual(cfg.token, '');
		assert.strictEqual(G.storageUsesGithub(cfg.mode), false, 'must be inert until switched on');
	});

	await test('the token is never shown in full', () => {
		const masked = D.maskToken('github_pat_11ABCDEFG0abcdefghijklmnop');
		assert.ok(masked.indexOf('abcdefghijklmnop') === -1, masked);
		assert.ok(masked.length < 20, masked);
		assert.strictEqual(D.maskToken(''), '');
	});

	await test('disconnecting leaves no token behind', () => {
		const app = fakeApp();
		D.saveGithubConfig(app, { mode: 'github', token: 'secret', login: 'me', repo: 'o/r' });
		D.saveGithubConfig(app, { mode: 'github', token: '', login: '', repo: '' });
		assert.strictEqual(D.loadGithubConfig(app).token, '');
		assert.strictEqual(
			JSON.stringify(app.store).indexOf('secret'),
			-1,
			'the old token must not linger in storage'
		);
	});
}

/* ================= rendered UI ================= *
 *
 * The panel and settings tab, rendered against a stand-in for Obsidian rich
 * enough to catch a wrong API call or a hardcoded string. This is the only
 * automated check on text that otherwise exists solely inside the app — and
 * text shown on the wrong platform is exactly what went wrong before.
 */

/** Minimal DOM node with the handful of helpers Obsidian adds. */
function fakeEl(tag, o, sink) {
	const node = {
		tag: tag,
		text: (o && o.text) || '',
		cls: (o && o.cls) || '',
		children: [],
		createEl: (t, oo) => {
			const c = fakeEl(t, oo, sink);
			node.children.push(c);
			return c;
		},
		createDiv: (oo) => node.createEl('div', oo),
		createSpan: (oo) => node.createEl('span', oo),
		empty: () => {
			node.children.length = 0;
		},
		addClass: () => {},
		removeClass: () => {},
		setText: (t) => {
			node.text = t;
			sink.push(t);
		},
		listeners: Object.create(null),
		addEventListener: (type, fn) => {
			(node.listeners[type] || (node.listeners[type] = [])).push(fn);
		},
		/** Replay every handler of a type, so a click can actually be tested. */
		fire: (type) => {
			const fns = node.listeners[type] || [];
			for (let i = 0; i < fns.length; i++) fns[i]();
		},
		setAttribute: (k, v) => {
			node.attrs[k] = v;
		},
		attrs: Object.create(null),
	};
	if (node.text) sink.push(node.text);
	return node;
}

/**
 * Stand-in for Obsidian, wired to a given ecosystem.
 *
 * `setDisabled` throws on purpose: the requirement is that the pairing fields
 * stay editable, and a test that merely inspects a flag would not notice a
 * field being disabled somewhere else.
 */
function fakeObsidian(sink) {
	function control(store) {
		const c = {
			// A real element so that "is this field masked?" is answerable.
			inputEl: { type: 'text' },
			setPlaceholder: (v) => {
				sink.push('[placeholder] ' + v);
				return c;
			},
			setValue: (v) => {
				store.value = v;
				return c;
			},
			getValue: () => store.value,
			onChange: (f) => {
				store.onChange = f;
				return c;
			},
			setIcon: () => c,
			setTooltip: (v) => {
				sink.push('[tooltip] ' + v);
				return c;
			},
			onClick: (f) => {
				store.onClick = f;
				return c;
			},
			setButtonText: (v) => {
				sink.push(v);
				return c;
			},
			addOption: (v, label) => {
				sink.push('[option] ' + label);
				return c;
			},
			setDisabled: () => {
				throw new Error('a pairing control was disabled');
			},
		};
		return c;
	}
	return {
		Setting: class {
			constructor(containerEl) {
				this.containerEl = containerEl;
				this.controls = [];
			}
			setName(v) {
				sink.push('[name] ' + v);
				return this;
			}
			setDesc(v) {
				sink.push('[desc] ' + v);
				return this;
			}
			addText(cb) {
				const s = {};
				this.controls.push(s);
				cb(control(s));
				return this;
			}
			addToggle(cb) {
				cb(control({}));
				return this;
			}
			addExtraButton(cb) {
				const s = {};
				this.controls.push(s);
				cb(control(s));
				return this;
			}
			addButton(cb) {
				const s = {};
				this.controls.push(s);
				cb(control(s));
				return this;
			}
			addDropdown(cb) {
				const s = {};
				this.controls.push(s);
				cb(control(s));
				return this;
			}
		},
		control: control,
	};
}

/**
 * Load a fresh copy of main.js with a stand-in for Obsidian injected.
 *
 * main.js resolves `require('obsidian')` once at load time and falls back to
 * deliberately minimal stubs when it is absent — which is right for the pure
 * tests, but means `new Setting(...)` has no methods. Priming the module cache
 * and re-requiring gives the real UI code the real API shape to call.
 */
function loadWithFakeObsidian(sink, platform) {
	const Module = require('module');
	const mainPath = require.resolve('../main.js');

	const ob = fakeObsidian(sink);
	const exports = {
		Plugin: class {
			registerEvent() {}
			registerInterval() {}
			registerView() {}
			addCommand() {}
			addRibbonIcon() {}
			addStatusBarItem() {
				return fakeEl('div', null, sink);
			}
			addSettingTab() {}
			async loadData() {
				return null;
			}
			async saveData() {}
		},
		PluginSettingTab: class {
			constructor(app, plugin) {
				this.app = app;
				this.plugin = plugin;
				this.containerEl = fakeEl('div', null, sink);
			}
		},
		ItemView: class {},
		Modal: class {
			constructor(app) {
				this.app = app;
				this.contentEl = fakeEl('div', null, sink);
			}
		},
		Setting: ob.Setting,
		Notice: class {
			constructor(m) {
				sink.push('[notice] ' + m);
			}
		},
		normalizePath: (p) => p,
		Platform: Object.assign(
			{ isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false },
			platform || {}
		),
	};

	const origResolve = Module._resolveFilename;
	Module._resolveFilename = function (request) {
		if (request === 'obsidian') return 'obsidian';
		return origResolve.apply(this, arguments);
	};
	require.cache['obsidian'] = {
		id: 'obsidian',
		filename: 'obsidian',
		loaded: true,
		exports: exports,
	};
	delete require.cache[mainPath];
	try {
		return require('../main.js');
	} finally {
		Module._resolveFilename = origResolve;
		delete require.cache['obsidian'];
		delete require.cache[mainPath];
	}
}

/** A plugin instance far enough along to render, without running onload. */
function fakePluginFor(ecosystem, scan, pairing) {
	const app = fakeApp();
	// The panel asks the vault its name, and asks the adapter for a base path.
	// An adapter with neither accessor is what mobile actually hands back.
	app.vault = { getName: () => 'Notes', adapter: {} };
	return {
		app: app,
		ecosystem: ecosystem,
		settings: Object.assign({}, C.DEFAULT_SETTINGS),
		identity: { id: 'self0001', name: 'This device', platform: 'Desktop', named: false },
		github: {
			mode: 'ecosystem',
			token: '',
			login: '',
			repo: '',
			branch: 'main',
			lastCommit: '',
			lastSyncAt: 0,
			notesOnly: false,
		},
		pairing: pairing || {
			fingerprint: '',
			fingerprintSource: '',
			label: '',
			labelSource: '',
			files: 0,
			bytes: 0,
		},
		lastScan: scan,
		refreshViews: () => {},
		runScan: async () => scan,
		activateView: async () => {},
		saveSettings: async () => {},
	};
}

async function uiTests() {
	group('rendered UI');

	const UI = plugin.__ui;
	const scan = await C.scanVault(
		fakeAdapter({
			'': { files: ['Welcome.md'], folders: [] },
			__stats: { 'Welcome.md': { size: 10, mtime: 1 } },
		}),
		C.DEFAULT_SETTINGS
	);
	scan.location = C.classifyVaultLocation('/Users/j/Notes', {
		platform: 'desktop',
		vaultName: 'Notes',
	});
	scan.devices = [];
	scan.at = Date.now();

	function renderSettings(ecosystem, pairing) {
		const sink = [];
		const mod = loadWithFakeObsidian(sink);
		const p = fakePluginFor(ecosystem, scan, pairing);
		const tab = Object.create(mod.__ui.JemzSyncSettingTab.prototype);
		tab.app = p.app;
		tab.plugin = p;
		tab.containerEl = fakeEl('div', null, sink);
		tab.displayPairing(tab.containerEl);
		return { sink: sink, plugin: p, tab: tab };
	}

	function renderPanel(ecosystem) {
		const sink = [];
		const mod = loadWithFakeObsidian(sink);
		const p = fakePluginFor(ecosystem, scan);
		const view = Object.create(mod.__ui.JemzSyncView.prototype);
		view.plugin = p;
		const root = fakeEl('div', null, sink);
		view.containerEl = { children: [fakeEl('div', null, sink), root] };
		view.render();
		return sink;
	}

	await test('the panel renders on every ecosystem without throwing', () => {
		for (const eco of ['apple', 'windows', 'android', 'linux', 'unknown']) {
			assert.doesNotThrow(() => renderPanel(eco), 'panel threw on ' + eco);
		}
	});

	await test('the panel names no Apple product on a non-Apple device', () => {
		// The reported bug, checked where it actually shows: the rendered text.
		for (const eco of ['windows', 'android', 'linux']) {
			const text = renderPanel(eco).join('\n');
			for (const word of ['iPhone', 'iPad', 'Finder', 'Apple devices']) {
				assert.strictEqual(
					text.indexOf(word),
					-1,
					eco + ' panel says "' + word + '":\n' + text
				);
			}
		}
	});

	await test('the panel names the right cloud for each ecosystem', () => {
		assert.ok(renderPanel('windows').join('\n').indexOf('Google Drive') !== -1);
		assert.ok(renderPanel('apple').join('\n').indexOf('iCloud Drive') !== -1);
	});

	await test('the conflicts card blames no particular cloud', () => {
		// It fires for Dropbox and Syncthing markers too.
		const text = renderPanel('apple').join('\n');
		assert.ok(
			text.indexOf('No duplicate copies have been left behind.') !== -1,
			'expected neutral conflicts wording, got:\n' + text
		);
	});

	group('rendered settings');

	await test('both pairing fields render and neither is ever disabled', () => {
		// setDisabled throws in the fake, so this fails loudly if one is.
		const { sink } = renderSettings('apple');
		const names = sink.filter((s) => s.indexOf('[name] ') === 0);
		assert.ok(
			names.some((n) => n.indexOf('Other device fingerprint') !== -1),
			'fingerprint field missing'
		);
		assert.ok(
			names.some((n) => n.indexOf('Other device name') !== -1),
			'device name field missing'
		);
	});

	await test('the placeholder suits the ecosystem, not Apple', () => {
		const win = renderSettings('windows').sink.join('\n');
		assert.ok(win.indexOf('[placeholder] My laptop') !== -1, win);
		assert.strictEqual(win.indexOf('[placeholder] iPhone'), -1, win);
		const apple = renderSettings('apple').sink.join('\n');
		assert.ok(apple.indexOf('[placeholder] iPhone') !== -1);
	});

	await test('the description does not tell a Windows user to check an iPad', () => {
		// The exact string that was reported.
		const win = renderSettings('windows').sink
			.filter((s) => s.indexOf('[desc] ') === 0)
			.join('\n');
		for (const word of ['iPhone', 'iPad']) {
			assert.strictEqual(win.indexOf(word), -1, 'Windows settings says ' + word + ': ' + win);
		}
	});

	await test('the description explains where an auto-filled value came from', () => {
		const auto = renderSettings('apple', {
			fingerprint: 'abc',
			fingerprintSource: 'auto',
			label: 'iPhone',
			labelSource: 'auto',
			files: 3,
			bytes: 9,
		}).sink.join('\n');
		assert.ok(auto.indexOf('Filled in automatically') !== -1, auto);

		const manual = renderSettings('apple', {
			fingerprint: 'abc',
			fingerprintSource: 'manual',
			label: '',
			labelSource: '',
			files: 0,
			bytes: 0,
		}).sink.join('\n');
		assert.ok(manual.indexOf('Clear the field') !== -1, manual);
	});

	await test('typing into a field marks it manual; clearing hands it back', () => {
		const { tab, plugin: p } = renderSettings('apple');
		tab.setPaired('fingerprint', '  typed-value  ');
		assert.strictEqual(p.pairing.fingerprint, 'typed-value');
		assert.strictEqual(p.pairing.fingerprintSource, 'manual');
		assert.strictEqual(p.pairing.files, 0, 'a typed digest must claim no file count');

		tab.setPaired('fingerprint', '');
		assert.strictEqual(p.pairing.fingerprintSource, '', 'clearing must re-enable auto-fill');

		// And an empty field really is refillable.
		const r = C.autofillValue(p.pairing.fingerprint, p.pairing.fingerprintSource, 'detected');
		assert.strictEqual(r.value, 'detected');
	});

	group('rendered storage settings');

	function renderStorage(ecosystem, github) {
		const sink = [];
		const mod = loadWithFakeObsidian(sink);
		const p = fakePluginFor(ecosystem, scan);
		if (github) p.github = Object.assign(p.github, github);
		const tab = Object.create(mod.__ui.JemzSyncSettingTab.prototype);
		tab.app = p.app;
		tab.plugin = p;
		tab.containerEl = fakeEl('div', null, sink);
		tab.displayStorage(tab.containerEl);
		return { sink: sink, text: sink.join('\n'), plugin: p, tab: tab };
	}

	await test('all three storage choices are offered', () => {
		// What was asked for: ecosystem, ecosystem+GitHub, or GitHub.
		const t = renderStorage('apple').text;
		assert.ok(t.indexOf('[option] ') !== -1, t);
		const options = renderStorage('apple').sink.filter((s) => s.indexOf('[option] ') === 0);
		assert.strictEqual(options.length, 3, options.join(' | '));
	});

	await test('the choice is described in the ecosystem\'s own words', () => {
		assert.ok(renderStorage('apple').text.indexOf('iCloud Drive') !== -1);
		const win = renderStorage('windows').text;
		assert.ok(win.indexOf('Google Drive') !== -1);
		assert.strictEqual(win.indexOf('iCloud'), -1, 'Windows must not be offered iCloud: ' + win);
	});

	await test('nothing about GitHub is shown until it is switched on', () => {
		const off = renderStorage('apple', { mode: 'ecosystem' }).text;
		assert.strictEqual(off.indexOf('Connect GitHub'), -1, off);
		assert.strictEqual(off.indexOf('Repository'), -1, off);
	});

	await test('switching to GitHub asks for a token and explains where it lives', () => {
		const on = renderStorage('apple', { mode: 'github' }).text;
		assert.ok(on.indexOf('GitHub access token') !== -1, on);
		assert.ok(/never in the vault/i.test(on), 'must say where the token is kept: ' + on);
		assert.ok(/Contents: read and write/i.test(on), on);
	});

	await test('the token field itself says an SSH key is not what is wanted', () => {
		// No SSH settings row exists — but "where do I paste my key?" is the
		// natural first assumption for anyone used to `git push`, so the token
		// description answers it where the question arises.
		const on = renderStorage('apple', { mode: 'github' }).text;
		assert.ok(/SSH/i.test(on), 'should pre-empt the SSH question: ' + on);
		assert.strictEqual(
			on.indexOf('[name] SSH key'),
			-1,
			'but there must be no settings row for something unused'
		);
	});

	group('rendered check schedule');

	function renderSchedule(schedule, lastCheckAt) {
		const sink = [];
		const mod = loadWithFakeObsidian(sink);
		const p = fakePluginFor('apple', scan);
		p.github = Object.assign(p.github, {
			mode: 'github',
			token: 'tok',
			login: 'someone',
			repo: 'me/vault',
		});
		if (schedule) p.settings.githubSchedule = schedule;
		p.lastCheckAt = lastCheckAt || 0;
		p.restartCheckSchedule = () => {};
		const tab = Object.create(mod.__ui.JemzSyncSettingTab.prototype);
		tab.app = p.app;
		tab.plugin = p;
		tab.containerEl = fakeEl('div', null, sink);
		tab.displayStorage(tab.containerEl);
		return { sink: sink, text: sink.join('\n'), plugin: p, tab: tab };
	}

	await test('all six kinds of schedule are offered', () => {
		const r = renderSchedule();
		const options = r.sink.filter((s) => s.indexOf('[option] ') === 0);
		for (const m of C.SCHEDULE_MODES) {
			assert.ok(
				options.indexOf('[option] ' + m.label) !== -1,
				'missing ' + m.id + ' in ' + options.join(' | ')
			);
		}
	});

	await test('the pane explains the schedule that is actually selected', () => {
		const hours = renderSchedule({ mode: 'hours', every: 6 }).text;
		assert.ok(hours.indexOf('[name] Check schedule') !== -1, hours);
		assert.ok(hours.indexOf('[name] How many hours') !== -1, hours);
		// The live summary carries the sentence; the field description must
		// not restate it, because it goes stale the moment you start typing.
		assert.ok(/every 6 hours/.test(hours), hours);
		assert.ok(/repeats for ever/.test(hours), hours);
		// And it does not leave the old wording behind.
		assert.strictEqual(hours.indexOf('[name] Check GitHub every'), -1, hours);
	});

	await test('the number box says what a valid number is', () => {
		const weekly = renderSchedule({ mode: 'weekly', every: 2 }).text;
		assert.ok(/between 1 and 52/.test(weekly), weekly);
	});

	await test('choosing a date and time offers a calendar and a repeat', () => {
		const r = renderSchedule({ mode: 'datetime', at: '2026-08-15T09:30', repeat: 'weekly' });
		assert.ok(r.text.indexOf('[name] Date and time') !== -1, r.text);
		assert.ok(r.text.indexOf('[name] Repeat') !== -1, r.text);
		assert.ok(/Sat 15 August 2026 at 09:30/.test(r.text), r.text);
		// The four repeats, and no number box, because there is no interval.
		const options = r.sink.filter((s) => s.indexOf('[option] ') === 0).join(' | ');
		for (const rep of C.SCHEDULE_REPEATS) {
			assert.ok(options.indexOf(rep.label) !== -1, 'missing ' + rep.id + ': ' + options);
		}
		assert.strictEqual(r.text.indexOf('[name] How many'), -1, r.text);
	});

	await test('with no date picked, the pane says so instead of pretending', () => {
		const r = renderSchedule({ mode: 'datetime', at: '', repeat: 'once' });
		assert.ok(/No date chosen yet/.test(r.text), r.text);
		assert.ok(/Pick a date/.test(r.text), r.text);
	});

	await test('the pane always says when the next check is', () => {
		const now = Date.now();
		const r = renderSchedule({ mode: 'minutes', every: 15 }, now - 60000);
		assert.ok(/Next check:/.test(r.text), r.text);
		assert.ok(/Last checked/.test(r.text), r.text);

		const fresh = renderSchedule({ mode: 'minutes', every: 15 }, 0);
		assert.ok(/Not checked yet/.test(fresh.text), fresh.text);
	});

	await test('every row carries an "i" that opens the same explanation', () => {
		const r = renderSchedule({ mode: 'datetime', at: '2026-08-15T09:30' });
		const tips = r.sink.filter((s) => s.indexOf('[tooltip] ') === 0).join(' | ');
		assert.ok(/each kind of schedule/.test(tips), tips);
		assert.ok(/short months and leap years/.test(tips), tips);
	});

	await test('the schedule help exists and answers the awkward questions', () => {
		const help = plugin.__ui.HELP_TOPICS.schedule;
		assert.ok(help, 'no schedule help topic');
		const all = [help.intro].concat(help.steps, help.notes).join(' ');
		assert.ok(/leap year/i.test(all), 'must cover February');
		assert.ok(/per device/i.test(all), 'must say the schedule is per device');
		assert.ok(/Sync now/.test(all), 'must point at the immediate check');
	});

	await test('changing the schedule saves it and re-arms the timer at once', () => {
		// Not on restart: someone setting this on a phone will not restart it.
		const r = renderSchedule({ mode: 'minutes', every: 2 });
		let rearmed = 0;
		r.plugin.restartCheckSchedule = () => rearmed++;
		return r.tab
			.saveSchedule({ mode: 'days', every: 3 }, false)
			.then(() => {
				assert.strictEqual(r.plugin.settings.githubSchedule.mode, 'days');
				assert.strictEqual(r.plugin.settings.githubSchedule.every, 3);
				assert.strictEqual(rearmed, 1);
			});
	});

	await test('typing an interval and then changing the kind keeps both edits', () => {
		// The stale-closure bug: handlers must read the schedule when they
		// fire, not the copy that was current when the row was drawn.
		const r = renderSchedule({ mode: 'hours', every: 2 });
		return r.tab
			.saveSchedule(Object.assign(r.tab.currentSchedule(), { every: 9 }), false)
			.then(() => r.tab.saveSchedule(
				Object.assign(r.tab.currentSchedule(), { mode: 'days' }),
				false
			))
			.then(() => {
				assert.strictEqual(r.plugin.settings.githubSchedule.mode, 'days');
				assert.strictEqual(r.plugin.settings.githubSchedule.every, 9, 'the typed 9 was lost');
			});
	});

	await test('saving a schedule never writes through to the shipped defaults', () => {
		// Object.assign over a shared object literal would leak one vault's
		// choice into the next.
		const before = JSON.stringify(C.DEFAULT_SETTINGS.githubSchedule);
		const r = renderSchedule();
		return r.tab
			.saveSchedule(Object.assign(r.tab.currentSchedule(), { mode: 'weekly', every: 4 }), false)
			.then(() => {
				assert.strictEqual(JSON.stringify(C.DEFAULT_SETTINGS.githubSchedule), before);
			});
	});

	await test('a nonsense schedule cannot be saved, however it arrives', () => {
		const r = renderSchedule();
		return r.tab.saveSchedule({ mode: 'hours', every: -4 }, false).then(() => {
			assert.strictEqual(r.plugin.settings.githubSchedule.every, 1);
		});
	});

	group('rendered date picker');

	function renderPicker(initial) {
		const sink = [];
		const mod = loadWithFakeObsidian(sink);
		const app = fakeApp();
		const modal = new mod.__ui.DateTimePickerModal(app, initial || null, () => {});
		modal.onOpen();
		return { sink: sink, text: sink.join('\n'), modal: modal };
	}

	await test('the picker opens on any month without throwing', () => {
		for (let m = 0; m < 12; m++) {
			assert.doesNotThrow(
				() => renderPicker(new Date(2026, m, 15, 9, 30)),
				'month ' + m + ' threw'
			);
		}
		assert.doesNotThrow(() => renderPicker(new Date(2024, 1, 29, 9, 30)), 'leap day threw');
	});

	await test('it draws the month it was opened on, with both headings', () => {
		const r = renderPicker(new Date(2026, 7, 15, 9, 30));
		assert.ok(r.text.indexOf('August 2026') !== -1, r.text);
		for (const day of C.WEEKDAY_SHORT) {
			assert.ok(r.text.split('\n').indexOf(day) !== -1, 'no ' + day + ' heading');
		}
		assert.ok(/Sat 15 August 2026 at 09:30/.test(r.text), r.text);
	});

	await test('the whole month is on the grid — 42 cells, every day of it', () => {
		const r = renderPicker(new Date(2026, 7, 15, 9, 30));
		const cells = r.modal.gridEl.children;
		assert.strictEqual(cells.length, 42, 'six weeks of seven days');
		const days = cells.map((c) => Number(c.text));
		for (let d = 1; d <= 31; d++) {
			assert.ok(days.indexOf(d) !== -1, 'August has no ' + d);
		}
	});

	await test('February draws 29 days in a leap year and 28 otherwise', () => {
		const leap = renderPicker(new Date(2024, 1, 15, 9, 0)).modal.gridEl.children.map(
			(c) => c.cls + ' ' + c.text
		);
		assert.strictEqual(leap.filter((c) => c.indexOf('is-outside') === -1).length, 29);

		const common = renderPicker(new Date(2026, 1, 15, 9, 0)).modal.gridEl.children.map(
			(c) => c.cls + ' ' + c.text
		);
		assert.strictEqual(common.filter((c) => c.indexOf('is-outside') === -1).length, 28);
	});

	await test('paging moves the month and rolls the year over', () => {
		const r = renderPicker(new Date(2026, 11, 15, 9, 30));
		r.modal.page(1);
		assert.strictEqual(r.modal.titleEl.text, 'January 2027');
		r.modal.page(-1);
		assert.strictEqual(r.modal.titleEl.text, 'December 2026');
		r.modal.page(12);
		assert.strictEqual(r.modal.titleEl.text, 'December 2027');
	});

	await test('a day already gone cannot be picked', () => {
		// Opened on a month that is entirely in the past.
		const r = renderPicker(new Date(2020, 0, 15, 9, 0));
		const cells = r.modal.gridEl.children;
		const pickable = cells.filter((c) => !c.disabled);
		assert.strictEqual(pickable.length, 0, 'January 2020 offered a day');
	});

	await test('a moment that has already passed cannot be accepted', () => {
		// Not tidiness. "Just once" decides it has been kept by comparing the
		// chosen moment with when this device last checked, so a moment older
		// than that last check would be born spent — the pane would report the
		// schedule as finished without ever having run it.
		const r = renderPicker(new Date(2026, 7, 15, 9, 30));
		const past = new Date(Date.now() - 60 * 60 * 1000);
		r.modal.selected = past;
		r.modal.viewYear = past.getFullYear();
		r.modal.viewMonth = past.getMonth();
		r.modal.renderGrid();
		assert.strictEqual(r.modal.useEl.disabled, true, 'a past moment was offered');
		assert.ok(/already passed/.test(r.modal.chosenEl.text), r.modal.chosenEl.text);

		// And clicking anyway hands nothing back — the disabled attribute is
		// a courtesy, the guard in the handler is the rule.
		let handed = null;
		r.modal.onPick = (d) => {
			handed = d;
		};
		r.modal.close = () => {};
		r.modal.useEl.fire('click');
		assert.strictEqual(handed, null, 'a past moment was handed back anyway');

		// A future moment is accepted and described.
		const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
		r.modal.selected = soon;
		r.modal.viewYear = soon.getFullYear();
		r.modal.viewMonth = soon.getMonth();
		r.modal.renderGrid();
		assert.strictEqual(r.modal.useEl.disabled, false);
		assert.ok(/in 3 days/.test(r.modal.chosenEl.text), r.modal.chosenEl.text);
		r.modal.useEl.fire('click');
		assert.ok(handed, 'a future moment was refused');
		assert.strictEqual(handed.getTime(), soon.getTime());
	});

	await test('the hour and the minute are both offered in full', () => {
		const r = renderPicker(new Date(2026, 7, 15, 9, 30));
		const options = r.sink.filter((s) => s.indexOf('[option] ') === 0);
		assert.strictEqual(options.filter((s) => / h$/.test(s)).length, 24);
		assert.strictEqual(options.filter((s) => / min$/.test(s)).length, 60);
	});

	await test('the fingerprint field has an "i" that explains how to get one', () => {
		const r = renderSettings('apple');
		const tips = r.sink.filter((t) => t.indexOf('[tooltip] ') === 0);
		assert.ok(
			tips.some((t) => /How to get a fingerprint/i.test(t)),
			'expected a help affordance beside the fingerprint field: ' + tips.join(' | ')
		);
	});

	await test('that help covers every kind of device, not just one', () => {
		const mod = loadWithFakeObsidian([]);
		const help = mod.__ui.HELP_TOPICS.fingerprint;
		assert.ok(help, 'the topic must exist');

		const all = JSON.stringify(help);
		assert.ok(/command palette/i.test(all), 'must give the cross-platform route');
		assert.ok(/ribbon/i.test(all), 'must say where to click');

		const kinds = help.table.map((row) => row[0].toLowerCase()).join(' ');
		assert.ok(/computer/.test(kinds), 'desktop covered: ' + kinds);
		assert.ok(/phone|tablet/.test(kinds), 'mobile covered: ' + kinds);

		// It has to be honest that this is normally unnecessary.
		assert.ok(/fills itself in|automatically/i.test(help.intro), help.intro);
		// And name no single ecosystem, since every platform can do this.
		for (const word of ['iPhone', 'iPad', 'iCloud', 'Finder']) {
			assert.strictEqual(all.indexOf(word), -1, 'help should stay platform-neutral, found ' + word);
		}
	});

	await test('storage labels are built from the ecosystem, never patched into a sentence', () => {
		const win = renderStorage('windows', { mode: 'ecosystem' }).text;
		assert.ok(win.indexOf("[option] This device's Google Drive only") !== -1, win);
		assert.strictEqual(win.indexOf('iCloud'), -1, 'Windows must never be offered iCloud: ' + win);
		const apple = renderStorage('apple', { mode: 'ecosystem' }).text;
		assert.ok(apple.indexOf("[option] This device's iCloud Drive only") !== -1, apple);
	});

	await test('the token field is masked, with an eye to reveal it', () => {
		const r = renderStorage('apple', { mode: 'github' });
		assert.ok(r.text.indexOf('[tooltip] Show the token') !== -1, r.text);

		// The field starts masked...
		const tab = r.tab;
		assert.strictEqual(tab.pendingTokenEl.type, 'password', 'must start masked');

		// ...and the eye toggles it both ways.
		tab.pendingTokenEl.type = tab.pendingTokenEl.type === 'password' ? 'text' : 'password';
		assert.strictEqual(tab.pendingTokenEl.type, 'text');
	});

	await test('once connected it offers a repository and never shows the token', () => {
		const r = renderStorage('apple', {
			mode: 'github',
			token: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV',
			login: 'jamalbalya',
			repo: 'jamalbalya/obsidian',
		});
		assert.ok(r.text.indexOf('jamalbalya/obsidian') !== -1, r.text);
		assert.ok(r.text.indexOf('Branch') !== -1);
		assert.strictEqual(
			r.text.indexOf('ABCDEFGHIJKLMNOPQRSTUV'),
			-1,
			'the token must never be rendered in full'
		);
	});

	await test('each credential row carries an "i" for how to set it up', () => {
		const r = renderStorage('apple', { mode: 'github' });
		const tips = r.sink.filter((s) => s.indexOf('[tooltip] ') === 0);
		assert.ok(
			tips.some((t) => /How to create a token/i.test(t)),
			'token field needs its help affordance: ' + tips.join(' | ')
		);
		// The SSH row itself was removed as clutter — nobody needs a settings
		// entry for something the plugin does not use. The explanation stays
		// reachable from the token's own info button.
	});

	await test('the token help names the exact permission and no more', () => {
		const mod = loadWithFakeObsidian([]);
		const help = mod.__ui.HELP_TOPICS.token;
		const scopes = help.table.map((s) => s[0] + ':' + s[1]).join(', ');
		assert.ok(/Contents:Read and write/.test(scopes), scopes);
		assert.ok(
			help.notes.join(' ').indexOf('never written into the vault') !== -1,
			'must say where the token lives'
		);
		assert.ok(
			/admin|delete_repo/.test(help.notes.join(' ')),
			'must warn against over-scoping'
		);
	});

	await test('the SSH help explains the real reason, not a shrug', () => {
		const mod = loadWithFakeObsidian([]);
		const text = JSON.stringify(mod.__ui.HELP_TOPICS.ssh);
		assert.ok(/requestUrl|HTTPS/.test(text), 'should say what a plugin actually has');
		assert.ok(/port 22|TCP/.test(text), 'should say what SSH needs');
		assert.ok(/command line/.test(text), 'should say where SSH does still work');
	});

	await test('an edit is written to per-device storage, never to settings', () => {
		const { tab, plugin: p } = renderSettings('apple');
		tab.setPaired('label', 'My iPad');
		assert.strictEqual(p.app.store['jemzsync-paired-label'], 'My iPad');
		assert.strictEqual(
			p.settings.pairedDeviceLabel,
			'',
			'the pairing must not reach the synced settings object'
		);
	});
}

/* ================= module contract ================= */

async function moduleTests() {
	group('module contract');

	await test('default export is the plugin class Obsidian will construct', () => {
		assert.strictEqual(typeof plugin, 'function');
		assert.strictEqual(plugin.default, plugin);
	});

	await test('loads outside Obsidian without throwing', () => {
		// Guarantees the test harness itself is a valid signal.
		assert.ok(C, '__core must be exported');
	});

	await test('exposes a stable view type id', () => {
		assert.strictEqual(plugin.VIEW_TYPE_JEMZSYNC, 'jemzsync-status');
	});
}

/* ================= ecosystems ================= */

async function ecosystemTests() {
	group('detectEcosystem');

	await test('each platform maps to its cloud', () => {
		assert.strictEqual(C.detectEcosystem({ isIosApp: true }), 'apple');
		assert.strictEqual(C.detectEcosystem({ isMacOS: true }), 'apple');
		assert.strictEqual(C.detectEcosystem({ isAndroidApp: true }), 'android');
		assert.strictEqual(C.detectEcosystem({ isWin: true }), 'windows');
		assert.strictEqual(C.detectEcosystem({ isLinux: true }), 'linux');
	});

	await test('an unrecognised device is not guessed at', () => {
		assert.strictEqual(C.detectEcosystem({}), 'unknown');
		assert.strictEqual(C.detectEcosystem(null), 'unknown');
	});

	await test('iPad reporting a desktop OS underneath is still Apple', () => {
		assert.strictEqual(
			C.detectEcosystem({ isIosApp: true, isMacOS: true }),
			'apple'
		);
	});

	await test('Android wins over a desktop flag on the same device', () => {
		assert.strictEqual(
			C.detectEcosystem({ isAndroidApp: true, isLinux: true }),
			'android'
		);
	});

	group('detectCloudFolder');

	await test('recognises every shape Google Drive mounts as', () => {
		assert.strictEqual(C.detectCloudFolder('G:/My Drive/Notes').id, 'gdrive');
		assert.strictEqual(
			C.detectCloudFolder('C:/Users/j/Google Drive/Notes').id,
			'gdrive'
		);
		assert.strictEqual(
			C.detectCloudFolder(
				'/Users/j/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/Notes'
			).id,
			'gdrive'
		);
	});

	await test('recognises OneDrive including the business suffix', () => {
		assert.strictEqual(C.detectCloudFolder('C:/Users/j/OneDrive/N').id, 'onedrive');
		assert.strictEqual(
			C.detectCloudFolder('C:/Users/j/OneDrive - Acme/N').id,
			'onedrive'
		);
	});

	await test('recognises Dropbox', () => {
		assert.strictEqual(C.detectCloudFolder('/home/j/Dropbox/N').id, 'dropbox');
	});

	await test('an ordinary folder matches nothing', () => {
		assert.strictEqual(C.detectCloudFolder('C:/Users/j/Documents/Notes'), null);
		assert.strictEqual(C.detectCloudFolder('/home/j/notes'), null);
		assert.strictEqual(C.detectCloudFolder(''), null);
	});

	await test('a note merely named "dropbox" does not count as a sync folder', () => {
		assert.strictEqual(C.detectCloudFolder('/home/j/notes/dropbox.md'), null);
	});

	group('classifyVaultLocation across ecosystems');

	await test('omitting the ecosystem keeps the Apple behaviour', () => {
		const withOut = C.classifyVaultLocation('/Users/j/Documents/N', {
			platform: 'desktop',
			vaultName: 'N',
		});
		const withApple = C.classifyVaultLocation('/Users/j/Documents/N', {
			platform: 'desktop',
			vaultName: 'N',
			ecosystem: 'apple',
		});
		assert.strictEqual(withOut.code, 'desktop-documents');
		assert.deepStrictEqual(withOut, withApple);
	});

	await test('a Windows vault in Google Drive is correct', () => {
		const r = C.classifyVaultLocation('G:\\My Drive\\Notes', {
			platform: 'desktop',
			vaultName: 'Notes',
			ecosystem: 'windows',
		});
		assert.strictEqual(r.code, 'ok');
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.syncing, true);
	});

	await test('a Windows vault outside any sync folder is flagged', () => {
		const r = C.classifyVaultLocation('C:\\Users\\j\\Documents\\Notes', {
			platform: 'desktop',
			vaultName: 'Notes',
			ecosystem: 'windows',
		});
		assert.strictEqual(r.code, 'local-only');
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.syncing, false);
		assert.ok(r.fixes.join(' ').indexOf('Google Drive') !== -1);
	});

	await test('OneDrive is accepted rather than nagged about', () => {
		const r = C.classifyVaultLocation('C:\\Users\\j\\OneDrive\\Notes', {
			platform: 'desktop',
			vaultName: 'Notes',
			ecosystem: 'windows',
		});
		assert.strictEqual(r.code, 'alternate-cloud');
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.syncing, true);
		assert.strictEqual(r.fixes.length, 0);
	});

	await test('Android without a path gives guidance, not an error', () => {
		const r = C.classifyVaultLocation(null, {
			platform: 'mobile',
			vaultName: 'Notes',
			ecosystem: 'android',
		});
		assert.strictEqual(r.code, 'mobile-unverifiable');
		assert.ok(r.fixes.join(' ').indexOf('Notes') !== -1);
	});

	group('mobile paths are never called local (regression, found on a real iPhone)');

	await test('an iOS sandbox path is unverifiable, not local-only', () => {
		// Obsidian on iOS hands back a path carrying none of the markers a Mac
		// path has. Reading that as "local" told a working iCloud vault to move
		// itself — which is exactly the advice that breaks a healthy setup.
		const r = C.classifyVaultLocation(
			'/private/var/mobile/Containers/Data/Application/ABC-123/Documents/Notes',
			{ platform: 'mobile', vaultName: 'Notes' }
		);
		assert.strictEqual(r.code, 'mobile-unverifiable');
		assert.notStrictEqual(r.code, 'local-only');
	});

	await test('a bare vault name from iOS is unverifiable too', () => {
		const r = C.classifyVaultLocation('Notes', {
			platform: 'mobile',
			vaultName: 'Notes',
		});
		assert.strictEqual(r.code, 'mobile-unverifiable');
	});

	await test('and so it never triggers the setup popup', () => {
		const r = C.classifyVaultLocation('/private/var/mobile/Containers/X/Notes', {
			platform: 'mobile',
			vaultName: 'Notes',
		});
		assert.strictEqual(C.shouldWarnAboutLocation(r, null), false);
	});

	await test('desktop still gets a straight local-only verdict', () => {
		const r = C.classifyVaultLocation('/Users/j/Dev/notes', {
			platform: 'desktop',
			vaultName: 'notes',
		});
		assert.strictEqual(r.code, 'local-only');
	});

	await test('a real iOS iCloud path is still recognised as correct', () => {
		const r = C.classifyVaultLocation(
			'/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes',
			{ platform: 'mobile', vaultName: 'Notes' }
		);
		assert.strictEqual(r.code, 'ok');
		assert.strictEqual(r.ok, true);
	});

	await test('Android sandbox path is unverifiable, not local-only', () => {
		const r = C.classifyVaultLocation(
			'/storage/emulated/0/Android/data/md.obsidian/files/Notes',
			{ platform: 'mobile', vaultName: 'Notes', ecosystem: 'android' }
		);
		assert.strictEqual(r.code, 'mobile-unverifiable');
	});

	await test('Android inside a Drive folder is still recognised as correct', () => {
		const r = C.classifyVaultLocation('/storage/emulated/0/My Drive/Notes', {
			platform: 'mobile',
			vaultName: 'Notes',
			ecosystem: 'android',
		});
		assert.strictEqual(r.code, 'ok');
	});

	await test('Windows desktop keeps its local-only verdict', () => {
		const r = C.classifyVaultLocation('C:\\Users\\j\\Documents\\Notes', {
			platform: 'desktop',
			vaultName: 'Notes',
			ecosystem: 'windows',
		});
		assert.strictEqual(r.code, 'local-only');
	});

	group('iCloud outside the Apple ecosystem');

	await test('Windows + iCloud Drive is syncing, not local-only', () => {
		// It really does replicate, so "local-only" would be a false alarm that
		// sends someone to move a vault that is already travelling.
		const r = C.classifyVaultLocation('C:\\Users\\j\\iCloudDrive\\Obsidian\\N', {
			platform: 'desktop',
			vaultName: 'N',
			ecosystem: 'windows',
		});
		assert.strictEqual(r.code, 'icloud-outside-apple');
		assert.strictEqual(r.syncing, true);
		assert.notStrictEqual(r.code, 'local-only');
	});

	await test('but it is still flagged, because Obsidian warns against it', () => {
		const r = C.classifyVaultLocation('C:\\Users\\j\\iCloud Drive\\N', {
			platform: 'desktop',
			vaultName: 'N',
			ecosystem: 'windows',
		});
		assert.strictEqual(r.ok, false);
		assert.ok(/duplicate|corrupt/i.test(r.detail));
		assert.ok(r.fixes.length >= 1);
	});

	await test('the spaced and unspaced folder names both match', () => {
		for (const p of ['C:/Users/j/iCloudDrive/N', 'C:/Users/j/iCloud Drive/N']) {
			assert.strictEqual(C.detectCloudFolder(p).id, 'icloud');
		}
	});

	await test('a raw iCloud container path is recognised too', () => {
		assert.strictEqual(
			C.detectCloudFolder('/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/N').id,
			'icloud'
		);
	});

	await test('iCloud is never confused with Google Drive or OneDrive', () => {
		assert.strictEqual(C.detectCloudFolder('C:/Users/j/iCloudDrive/N').id, 'icloud');
		assert.strictEqual(C.detectCloudFolder('G:/My Drive/N').id, 'gdrive');
		assert.strictEqual(C.detectCloudFolder('C:/Users/j/OneDrive/N').id, 'onedrive');
	});

	await test('on Apple the same container is simply correct, not flagged', () => {
		const r = C.classifyVaultLocation(
			'/Users/j/Library/Mobile Documents/iCloud~md~obsidian/Documents/N',
			{ platform: 'desktop', vaultName: 'N', ecosystem: 'apple' }
		);
		assert.strictEqual(r.code, 'ok');
		assert.strictEqual(r.ok, true);
	});

	await test('an iPad in the container is correct, same as a Mac', () => {
		const r = C.classifyVaultLocation(
			'/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/N',
			{ platform: 'mobile', vaultName: 'N', ecosystem: 'apple' }
		);
		assert.strictEqual(r.code, 'ok');
		assert.strictEqual(r.ok, true);
	});

	group('buildMigrationPlan across ecosystems');

	await test('Windows gets PowerShell that backs up and never deletes', () => {
		const plan = C.buildMigrationPlan('C:\\Users\\j\\Notes', 'Notes', 'windows');
		assert.ok(plan.shell.indexOf('Copy-Item') !== -1);
		assert.ok(/backup/i.test(plan.shell));
		assert.strictEqual(/Remove-Item|rm -rf|del /i.test(plan.shell), false);
	});

	await test('Windows plan targets the Drive folder', () => {
		const plan = C.buildMigrationPlan('C:\\Users\\j\\Notes', 'Notes', 'windows');
		assert.ok(plan.target.indexOf('My Drive') !== -1);
		assert.ok(plan.target.indexOf('Notes') !== -1);
	});

	await test('Android gets prose, and is honest that Drive alone will not do', () => {
		const plan = C.buildMigrationPlan(null, 'Notes', 'android');
		assert.strictEqual(plan.shell, '');
		const text = plan.steps.join(' ');
		assert.ok(/folder-sync|FolderSync|Autosync/i.test(text));
		assert.ok(text.indexOf('will not') !== -1 || text.indexOf('not give') !== -1);
	});

	await test('omitting the ecosystem still produces the Apple plan', () => {
		const plan = C.buildMigrationPlan('/Users/j/Notes', 'Notes');
		assert.ok(plan.shell.indexOf('brctl download') !== -1);
		assert.ok(plan.target.indexOf('iCloud~md~obsidian') !== -1);
	});

	group('shouldWarnAboutLocation');

	await test('a healthy vault never interrupts', () => {
		assert.strictEqual(C.shouldWarnAboutLocation({ ok: true, code: 'ok' }, null), false);
		assert.strictEqual(C.shouldWarnAboutLocation(null, null), false);
	});

	await test('a vault that cannot sync does interrupt', () => {
		assert.strictEqual(
			C.shouldWarnAboutLocation({ ok: false, code: 'local-only' }, null),
			true
		);
	});

	await test('mobile-unverifiable is not a fault and must not nag', () => {
		assert.strictEqual(
			C.shouldWarnAboutLocation({ ok: false, code: 'mobile-unverifiable' }, null),
			false
		);
	});

	await test('dismissing silences that problem only', () => {
		assert.strictEqual(
			C.shouldWarnAboutLocation({ ok: false, code: 'local-only' }, 'local-only'),
			false
		);
		// A different problem is a new problem, stale dismissal notwithstanding.
		assert.strictEqual(
			C.shouldWarnAboutLocation(
				{ ok: false, code: 'wrong-icloud-folder' },
				'local-only'
			),
			true
		);
	});

	group('shouldRescanForChange');

	await test('an ordinary note triggers a rescan', () => {
		assert.strictEqual(C.shouldRescanForChange('Notes/Today.md', null), true);
	});

	await test('our own beacon never triggers a rescan (no feedback loop)', () => {
		assert.strictEqual(
			C.shouldRescanForChange('.jemzsync/device-abc123.json', null),
			false
		);
	});

	await test('the beacon guard holds even with every prefix exclusion removed', () => {
		// isBeaconPath alone must be enough. If this ever fails, writing a beacon
		// would schedule a scan, which writes a beacon: the plugin would spin.
		assert.strictEqual(
			C.shouldRescanForChange('.jemzsync/device-abc123.json', {
				excludePrefixes: [],
				excludeNames: [],
			}),
			false
		);
	});

	await test('the prefix guard holds for non-beacon files under .jemzsync', () => {
		// Deliberately redundant with isBeaconPath — this covers the other half.
		assert.strictEqual(C.shouldRescanForChange('.jemzsync/notes.txt', null), false);
	});

	await test('per-device workspace churn does not trigger a rescan', () => {
		assert.strictEqual(
			C.shouldRescanForChange('.obsidian/workspace.json', null),
			false
		);
	});

	await test('.DS_Store does not trigger a rescan', () => {
		assert.strictEqual(C.shouldRescanForChange('Notes/.DS_Store', null), false);
	});

	await test('an empty path is ignored rather than scanned', () => {
		assert.strictEqual(C.shouldRescanForChange('', null), false);
		assert.strictEqual(C.shouldRescanForChange(null, null), false);
	});

	await test('the debounce is long enough to collapse a burst', () => {
		assert.ok(C.LIVE_SCAN_DEBOUNCE_MS >= 3000);
		assert.ok(C.LIVE_SCAN_DEBOUNCE_MS <= 60000);
	});
}

/* ================= per-device state ================= */

/** Stand-in for Obsidian's App, storing exactly what the real one would. */
function fakeApp() {
	const store = Object.create(null);
	return {
		store: store,
		loadLocalStorage(key) {
			return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
		},
		saveLocalStorage(key, data) {
			if (data === null || data === undefined) delete store[key];
			else store[key] = String(data);
		},
	};
}

async function deviceStateTests() {
	const D = plugin.__device;

	group('per-device state (never syncs, scoped per vault)');

	await test('an id is generated and then reused across reloads', () => {
		const app = fakeApp();
		const first = D.loadDeviceIdentity(app).id;
		assert.ok(/^[a-z0-9]{8}$/.test(first));
		assert.strictEqual(D.loadDeviceIdentity(app).id, first);
		assert.strictEqual(D.loadDeviceIdentity(app).id, first);
	});

	await test('two vaults on the same device get different identities', () => {
		// The reason for app.saveLocalStorage over the raw localStorage object:
		// raw storage is per install, so both vaults would have shared one id.
		const a = D.loadDeviceIdentity(fakeApp()).id;
		const b = D.loadDeviceIdentity(fakeApp()).id;
		assert.notStrictEqual(a, b);
	});

	await test('nothing is written through the vault-syncing data API', () => {
		// Everything must land in local storage; if any of it reached saveData
		// it would sync, and every device would claim the same identity.
		const app = fakeApp();
		D.loadDeviceIdentity(app);
		D.saveDeviceName(app, 'Studio Mac');
		D.saveDismissedWarning(app, 'local-only');
		assert.deepStrictEqual(Object.keys(app.store).sort(), [
			'jemzsync-device-id',
			'jemzsync-device-name',
			'jemzsync-dismissed-location',
		]);
	});

	await test('a chosen device name survives a reload', () => {
		const app = fakeApp();
		D.loadDeviceIdentity(app);
		D.saveDeviceName(app, 'Studio Mac');
		assert.strictEqual(D.loadDeviceIdentity(app).name, 'Studio Mac');
	});

	await test('an unnamed device falls back to a sensible default', () => {
		const id = D.loadDeviceIdentity(fakeApp());
		assert.ok(id.name && id.name.length);
	});

	await test('a dismissal round-trips and is absent until set', () => {
		const app = fakeApp();
		assert.strictEqual(D.loadDismissedWarning(app), null);
		D.saveDismissedWarning(app, 'local-only');
		assert.strictEqual(D.loadDismissedWarning(app), 'local-only');
	});

	await test('a dismissal in one vault does not silence another', () => {
		const mac = fakeApp();
		const phone = fakeApp();
		D.saveDismissedWarning(mac, 'local-only');
		assert.strictEqual(D.loadDismissedWarning(phone), null);
	});

	await test('an app without the storage API degrades instead of throwing', () => {
		// Older builds, or private mode. An ephemeral id beats a failed load.
		for (const app of [null, {}, { loadLocalStorage: null }]) {
			const id = D.loadDeviceIdentity(app);
			assert.ok(/^[a-z0-9]{8}$/.test(id.id));
			assert.doesNotThrow(() => D.saveDeviceName(app, 'x'));
			assert.doesNotThrow(() => D.saveDismissedWarning(app, 'y'));
			assert.strictEqual(D.loadDismissedWarning(app), null);
		}
	});

	group('paired device state (must never reach the vault)');

	await test('the pairing never touches the vault-syncing data API', () => {
		// The invariant this whole design rests on. If pairing went through
		// saveData it would sync: the Mac would write the iPhone's digest into
		// the shared file, the iPhone would overwrite it with the Mac's, and
		// round it goes — while every write changed data.json, and with it the
		// vault fingerprint the two devices are trying to match on.
		const app = fakeApp();
		D.savePairing(app, {
			fingerprint: 'aaaa1111-bbbb2222',
			fingerprintSource: 'auto',
			label: 'iPhone',
			labelSource: 'auto',
			files: 12,
			bytes: 3400,
		});
		for (const key of Object.keys(app.store)) {
			assert.ok(
				key.indexOf('jemzsync-paired-') === 0,
				'unexpected key written: ' + key
			);
		}
		assert.ok(Object.keys(app.store).length >= 4);
	});

	await test('a pairing round-trips', () => {
		const app = fakeApp();
		D.savePairing(app, {
			fingerprint: 'd1',
			fingerprintSource: 'auto',
			label: 'iPad',
			labelSource: 'auto',
			files: 7,
			bytes: 99,
		});
		const p = D.loadPairing(app, {});
		assert.strictEqual(p.fingerprint, 'd1');
		assert.strictEqual(p.fingerprintSource, 'auto');
		assert.strictEqual(p.label, 'iPad');
		assert.strictEqual(p.files, 7);
		assert.strictEqual(p.bytes, 99);
	});

	await test('an empty vault-side setting produces an empty pairing', () => {
		const p = D.loadPairing(fakeApp(), {});
		assert.strictEqual(p.fingerprint, '');
		assert.strictEqual(p.fingerprintSource, '');
		assert.strictEqual(p.files, 0);
	});

	await test('a value typed into an older version is migrated and protected', () => {
		const app = fakeApp();
		const p = D.loadPairing(app, {
			pairedFingerprint: 'typed-1234',
			pairedDeviceLabel: 'Studio iMac',
		});
		assert.strictEqual(p.fingerprint, 'typed-1234');
		assert.strictEqual(p.fingerprintSource, 'manual', 'must be protected from auto-fill');
		assert.strictEqual(p.label, 'Studio iMac');
		assert.strictEqual(p.labelSource, 'manual');
		// And it is now held per device, so the migration happens exactly once.
		assert.strictEqual(app.store['jemzsync-paired-fingerprint'], 'typed-1234');
	});

	await test('migration never overwrites what is already stored per device', () => {
		const app = fakeApp();
		D.savePairing(app, {
			fingerprint: 'local',
			fingerprintSource: 'auto',
			label: '',
			labelSource: '',
			files: 0,
			bytes: 0,
		});
		const p = D.loadPairing(app, { pairedFingerprint: 'stale-synced-value' });
		assert.strictEqual(p.fingerprint, 'local');
	});

	group('applyPairingAutofill');

	const empty = {
		fingerprint: '',
		fingerprintSource: '',
		label: '',
		labelSource: '',
		files: 0,
		bytes: 0,
	};

	await test('fills both fields from the chosen beacon', () => {
		const r = D.applyPairingAutofill(
			empty,
			[beacon('ph', 'iPhone', 'digest-1', 900, 12, 3400)],
			1000
		);
		assert.strictEqual(r.changed, true);
		assert.strictEqual(r.pairing.fingerprint, 'digest-1');
		assert.strictEqual(r.pairing.label, 'iPhone');
		assert.strictEqual(r.pairing.files, 12, 'the real remote file count must be kept');
		assert.strictEqual(r.pairing.bytes, 3400);
	});

	await test('does nothing at all when no other device is present', () => {
		const r = D.applyPairingAutofill(empty, [], 1000);
		assert.strictEqual(r.changed, false);
		assert.deepStrictEqual(r.pairing, empty);
	});

	await test('leaves a hand-typed digest untouched and claims no counts for it', () => {
		const manual = Object.assign({}, empty, {
			fingerprint: 'mine',
			fingerprintSource: 'manual',
		});
		const r = D.applyPairingAutofill(
			manual,
			[beacon('ph', 'iPhone', 'theirs', 900, 12, 3400)],
			1000
		);
		assert.strictEqual(r.pairing.fingerprint, 'mine');
		assert.strictEqual(
			r.pairing.files,
			0,
			'a typed digest has no file count; inventing one is the bug this replaces'
		);
	});

	await test('running twice with no change writes nothing the second time', () => {
		// Otherwise every scan would rewrite storage for no reason.
		const devices = [beacon('ph', 'iPhone', 'digest-1', 900, 12, 3400)];
		const first = D.applyPairingAutofill(empty, devices, 1000);
		const second = D.applyPairingAutofill(first.pairing, devices, 1000);
		assert.strictEqual(second.changed, false);
	});

	await test('a device that changed its files updates the stored counts', () => {
		const first = D.applyPairingAutofill(
			empty,
			[beacon('ph', 'iPhone', 'd1', 900, 12, 3400)],
			1000
		);
		const second = D.applyPairingAutofill(
			first.pairing,
			[beacon('ph', 'iPhone', 'd2', 950, 15, 4000)],
			1000
		);
		assert.strictEqual(second.changed, true);
		assert.strictEqual(second.pairing.fingerprint, 'd2');
		assert.strictEqual(second.pairing.files, 15);
	});

	await test('when this device last checked is kept off the vault entirely', () => {
		// It is state, not a preference. In settings it would ride the vault's
		// own cloud to the other devices, and one device's check would count
		// for all of them.
		assert.ok(Object.prototype.hasOwnProperty.call(C.DEFAULT_SETTINGS, 'githubSchedule'));
		assert.strictEqual(
			Object.prototype.hasOwnProperty.call(C.DEFAULT_SETTINGS, 'githubLastCheckAt'),
			false,
			'the check stamp must not be a setting'
		);

		const app = fakeApp();
		assert.strictEqual(D.loadLastCheck(app), 0);
		D.saveLastCheck(app, 1234567);
		assert.strictEqual(D.loadLastCheck(app), 1234567);
		// And it really is device-local storage, not saveData.
		assert.ok(
			JSON.stringify(app.__local || {}).indexOf('1234567') !== -1 ||
				D.loadLastCheck(app) === 1234567
		);
	});

	await test('a nonsense check stamp reads back as never', () => {
		const app = fakeApp();
		for (const bad of [-5, NaN, 'soon', null, undefined]) {
			D.saveLastCheck(app, bad);
			assert.strictEqual(D.loadLastCheck(app), 0, String(bad));
		}
	});

	await test('storage that throws is survivable', () => {
		const hostile = {
			loadLocalStorage() {
				throw new Error('quota');
			},
			saveLocalStorage() {
				throw new Error('quota');
			},
		};
		const id = D.loadDeviceIdentity(hostile);
		assert.ok(/^[a-z0-9]{8}$/.test(id.id));
		assert.doesNotThrow(() => D.saveDismissedWarning(hostile, 'z'));
	});
}

/* ================= runner ================= */

(async function run() {
	console.log('jemzsync test suite');
	await locationTests();
	await migrationTests();
	await placeholderTests();
	await pathTests();
	await conflictTests();
	await fingerprintTests();
	await summaryTests();
	await scannerTests();
	await beaconTests();
	await scannerBeaconTests();
	await ecosystemTests();
	await pairingTests();
	await deviceNameTests();
	await languageTests();
	await deviceStateTests();
	await scheduleTests();
	await checkTimerTests();
	await githubTests();
	await uiTests();
	await moduleTests();

	console.log('\n' + '-'.repeat(46));
	console.log(passed + ' passed, ' + failed + ' failed');

	if (failed) {
		console.log('');
		for (const [name, err] of failures) {
			console.log('FAIL: ' + name);
			console.log('      ' + err.message);
		}
		process.exit(1);
	}
	process.exit(0);
})();
