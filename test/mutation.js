'use strict';

/*
 * Mutation testing for the jemzsync test suite.
 *
 *   npm run test:mutation
 *
 * Verifies the suite is worth trusting: each entry below injects a known bug
 * into a temporary copy of main.js and asserts the suite fails. A mutation
 * that survives means a class of regression the tests would let through.
 *
 * The real main.js is never modified — everything happens in a temp dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'jemzsync-mut-'));

fs.mkdirSync(path.join(SANDBOX, 'test'));
fs.copyFileSync(path.join(ROOT, 'main.js'), path.join(SANDBOX, 'main.js'));
fs.copyFileSync(
	path.join(ROOT, 'test', 'test-core.js'),
	path.join(SANDBOX, 'test', 'test-core.js')
);

const original = fs.readFileSync(path.join(SANDBOX, 'main.js'), 'utf8');

const mutations = [
	['conflict requiresOriginal disabled (false positives)',
		'requiresOriginal: true', 'requiresOriginal: false'],
	['mtime folded into fingerprint (brittle across devices)',
		"hA ^= fnv1a(e.path + ':' + (e.size || 0));",
		"hA ^= fnv1a(e.path + ':' + (e.size || 0) + ':' + (e.mtime || 0));"],
	['generic iCloud Drive no longer flagged',
		'if (p.indexOf(GENERIC_ICLOUD) !== -1) {', 'if (0) {'],
	['chooseWinner picks oldest',
		'if (e.mtime > best.mtime) best = e;', 'if (e.mtime < best.mtime) best = e;'],
	['chooseWinner size tiebreak inverted',
		'if (e.size > best.size) best = e;', 'if (e.size < best.size) best = e;'],
	['visited-folder guard removed (cycle risk)',
		'if (seen[dir]) continue;', 'if (0) continue;'],
	['workspace/.DS_Store/beacon exclusions dropped',
		"excludePrefixes: ['.obsidian/workspace', '.trash/', '.git/', '.jemzsync/'],",
		'excludePrefixes: [],'],
	['migration uses ~ inside quotes (would not expand)',
		"'$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents'",
		"'~/Library/Mobile Documents/iCloud~md~obsidian/Documents'"],
	['backup cp command removed entirely',
		'cp -R "\' + src + \'" "$HOME/Desktop/',
		'echo skipped "\' + src + \'" "$HOME/Desktop/'],
	['migration deletes the original',
		'brctl download "', 'rm -rf "'],
	['container depth check removed',
		'if (!inDocuments) {', 'if (0) {'],
	['left digest half stops reacting to size',
		"hA ^= fnv1a(e.path + ':' + (e.size || 0));", 'hA ^= fnv1a(e.path);'],
	['right digest half stops reacting to bytes',
		"toHex8(fnv1a(kept.length + ':' + bytes))",
		'toHex8(fnv1a(String(kept.length)))'],
	['summarizeScan no longer ranks conflicts first',
		'if (scan.conflicts && scan.conflicts.length) {', 'if (0) {'],
	['placeholder regex made greedy (eats real files)',
		'const PLACEHOLDER_RE = /^\\.(.+)\\.icloud$/;',
		'const PLACEHOLDER_RE = /(.*)/;'],
	['mobile branch returns generic error instead of guidance',
		"code: 'mobile-unverifiable',", "code: 'unknown',"],
	['beacon parser accepts foreign JSON kinds',
		"if (!obj || obj.kind !== 'jemzsync-beacon') return { ok: false };",
		'if (!obj) return { ok: false };'],
	['own beacon leaks into the others list',
		'if (b.id === selfId) mine.push(b);', 'if (false) mine.push(b);'],
	['beacon writes suppressed forever',
		'if (!prev) return true;', 'if (!prev) return false;'],
	['beacon heartbeat interval ignored (constant churn)',
		'if (now - (prev.updatedAt || 0) >= minIntervalMs) return true;\n\treturn false;',
		'return true;'],

	/* --- ecosystem detection and the live watcher (1.2.0) --- */

	['Android no longer detected (would be told to use iCloud)',
		"if (flags.isAndroidApp) return 'android';",
		"if (false) return 'android';"],
	['iOS falls through to the desktop OS check',
		"if (flags.isIosApp) return 'apple';",
		"if (false) return 'apple';"],
	['Google Drive "My Drive" folder no longer recognised',
		're: /(^|\\/)My Drive(\\/|$)/i },',
		're: /zzz-never-matches/ },'],
	['ecosystem defaulting flipped away from Apple (breaks existing callers)',
		"const ecosystem = ctx.ecosystem || 'apple';",
		"const ecosystem = ctx.ecosystem || 'windows';"],
	['OneDrive/Dropbox no longer accepted as valid sync folders',
		'if (cloud) {',
		'if (0) {'],
	['setup popup nags even when the vault is fine',
		'if (!location || location.ok) return false;',
		'if (!location) return false;'],
	['setup popup ignores "don\'t warn me again"',
		'return dismissedCode !== location.code;',
		'return true;'],
	['setup popup nags on mobile where the path is unreadable',
		"if (location.code === 'mobile-unverifiable') return false;",
		'if (0) return false;'],
	['beacon guard removed from the watcher (scan -> beacon -> scan loop)',
		'if (isBeaconPath(p)) return false;',
		'if (false) return false;'],
	['live rescan debounce removed (a scan per keystroke)',
		'const LIVE_SCAN_DEBOUNCE_MS = 8 * 1000;',
		'const LIVE_SCAN_DEBOUNCE_MS = 0;'],
	['Windows migration deletes the original instead of copying',
		'\'Copy-Item -Recurse "\' + src + \'" "\' + target + \'"\',',
		'\'Remove-Item -Recurse "\' + src + \'"\','],
];

let caught = 0;
let missed = 0;
let bad = 0;

console.log('Mutation testing (sandbox: ' + SANDBOX + ')\n');

for (const [label, find, repl] of mutations) {
	if (!original.includes(find)) {
		console.log('  ANCHOR MISS  ' + label);
		bad++;
		continue;
	}
	fs.writeFileSync(path.join(SANDBOX, 'main.js'), original.replace(find, repl));

	let out = '';
	let timedOut = false;
	try {
		out = execSync(process.execPath + ' test/test-core.js', {
			cwd: SANDBOX,
			encoding: 'utf8',
			timeout: 20000,
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch (err) {
		out = String(err.stdout || '') + String(err.stderr || '');
		if (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') timedOut = true;
	}

	const m = out.match(/(\d+) passed, (\d+) failed/);
	const survived = !timedOut && m && m[2] === '0';

	if (survived) {
		console.log('  NOT CAUGHT   ' + label);
		missed++;
	} else {
		const how = timedOut
			? 'hang detected'
			: m
			? m[2] + ' test(s) failed'
			: 'crashed';
		console.log('  caught       ' + label + '  (' + how + ')');
		caught++;
	}
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log('\n' + caught + ' caught, ' + missed + ' missed, ' + bad + ' bad anchors');
process.exit(missed || bad ? 1 : 0);
