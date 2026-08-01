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
