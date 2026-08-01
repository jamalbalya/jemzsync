'use strict';

/*
 * jemzsync — iCloud sync manager for Obsidian on Apple devices.
 *
 * What this file is:
 *   A build-free Obsidian plugin. Obsidian loads `main.js` directly, so there is
 *   no TypeScript step, no npm install, and no bundler. That means the exact same
 *   file can be dropped into a vault on macOS, iPadOS and iOS.
 *
 * Design note:
 *   iCloud Drive does the syncing. This plugin does not move your bytes and does
 *   not talk to Apple's servers — a plugin has no iCloud entitlement and cannot
 *   get one. What it does is make iCloud sync verifiable and repairable from
 *   inside Obsidian: check the vault is in the folder iOS can see, prove both
 *   devices hold the same files, and clean up the duplicates iCloud leaves behind.
 *
 * Uses zero Node.js and zero Electron APIs, so it runs on mobile
 * (`isDesktopOnly: false`).
 */

/* ------------------------------------------------------------------ *
 * Module loading
 *
 * `require('obsidian')` only resolves inside Obsidian. Falling back to stubs
 * lets this file also be required by the Node test harness in test/.
 * ------------------------------------------------------------------ */

function safeRequire(id) {
	try {
		return require(id);
	} catch (_) {
		return null;
	}
}

function headlessStubs() {
	class Base {}
	function Notice() {}
	return {
		__headless: true,
		Plugin: class {
			constructor() {}
			registerEvent() {}
			registerInterval() {}
			registerView() {}
			addCommand() {}
			addRibbonIcon() {}
			addStatusBarItem() {
				return { setText() {}, addClass() {}, removeClass() {} };
			}
			addSettingTab() {}
			async loadData() {
				return null;
			}
			async saveData() {}
		},
		PluginSettingTab: Base,
		ItemView: Base,
		Modal: Base,
		Setting: Base,
		Notice: Notice,
		normalizePath: (p) => p,
		Platform: {
			isDesktopApp: false,
			isMobileApp: false,
			isIosApp: false,
			isMacOS: false,
		},
	};
}

const ob = safeRequire('obsidian') || headlessStubs();

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const VIEW_TYPE_JEMZSYNC = 'jemzsync-status';
const PLUGIN_ID = 'jemzsync';

/** Hidden folder inside the vault where each device announces itself. */
const BEACON_DIR = '.jemzsync';
const BEACON_PREFIX = '.jemzsync/device-';
/** Don't rewrite an unchanged beacon more often than this — avoids iCloud churn. */
const BEACON_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** A device silent for this long is shown as stale rather than out of sync. */
const BEACON_STALE_MS = 48 * 60 * 60 * 1000;

/** The private iCloud container Obsidian owns. Mobile Obsidian only reads vaults from here. */
const OBSIDIAN_CONTAINER = 'iCloud~md~obsidian';
/** Generic iCloud Drive. A vault here syncs, but mobile Obsidian will not list it. */
const GENERIC_ICLOUD = 'com~apple~CloudDocs';
/** Root of every iCloud container on macOS. */
const MOBILE_DOCUMENTS = 'Library/Mobile Documents';

/** Shell-safe form of the folder mobile Obsidian reads from. */
const CONTAINER_SHELL_PATH =
	'$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents';

const DEFAULT_SETTINGS = {
	scanOnStartup: true,
	autoScanMinutes: 15,
	notifyOnConflicts: true,
	showStatusBar: true,
	/** Paths matching these prefixes never count toward the fingerprint. */
	excludePrefixes: ['.obsidian/workspace', '.trash/', '.git/', '.jemzsync/'],
	/** Filenames ignored everywhere. */
	excludeNames: ['.DS_Store'],
	/** Announce this device to the others by writing a small file in the vault. */
	writeBeacon: true,
	/** Remembered so a second device can be compared without retyping. */
	pairedFingerprint: '',
	pairedDeviceLabel: '',
};

/* ================================================================== *
 * CORE — pure functions, no Obsidian and no I/O. Everything in this
 * block is unit-tested by test/test-core.js.
 * ================================================================== */

/**
 * Work out where a vault lives and whether iCloud can sync it to an iPhone.
 *
 * @param {string|null} basePath absolute vault path, or null when unavailable
 * @param {{platform?: string, vaultName?: string}} ctx
 * @returns {{code: string, ok: boolean, syncing: boolean, title: string,
 *            detail: string, fixes: string[]}}
 */
function classifyVaultLocation(basePath, ctx) {
	ctx = ctx || {};
	const platform = ctx.platform || 'unknown';
	const vaultName = ctx.vaultName || 'YourVault';

	if (!basePath) {
		if (platform === 'mobile') {
			return {
				code: 'mobile-unverifiable',
				ok: false,
				syncing: false,
				title: 'Check the vault location in the Files app',
				detail:
					'Obsidian on iOS and iPadOS does not expose the vault path, so jemzsync cannot read it. Verify it by hand, then use the fingerprint below to confirm the two devices match.',
				fixes: [
					'Open Files → Browse → iCloud Drive.',
					'Confirm there is an Obsidian folder carrying the Obsidian icon, and that "' +
						vaultName +
						'" sits inside it.',
					'A vault under "On My iPhone" is stored locally and will never sync.',
				],
			};
		}
		return {
			code: 'unknown',
			ok: false,
			syncing: false,
			title: 'Vault path unavailable',
			detail: 'Obsidian did not report a path for this vault.',
			fixes: ['Restart Obsidian and run the check again.'],
		};
	}

	const p = String(basePath).replace(/\\/g, '/').replace(/\/+$/, '');

	if (p.indexOf(OBSIDIAN_CONTAINER) !== -1) {
		const inDocuments = /iCloud~md~obsidian\/Documents\//.test(p + '/');
		if (!inDocuments) {
			return {
				code: 'container-wrong-depth',
				ok: false,
				syncing: true,
				title: 'Vault is in the Obsidian container but at the wrong depth',
				detail:
					'The vault must sit directly inside the container\'s Documents folder for mobile Obsidian to list it.',
				fixes: [
					'Move the vault so its path ends with iCloud~md~obsidian/Documents/' +
						vaultName +
						'.',
				],
			};
		}
		return {
			code: 'ok',
			ok: true,
			syncing: true,
			title: 'Vault is in the right place',
			detail:
				'This vault lives in the iCloud folder Obsidian owns, so every device on your Apple Account can open it.',
			fixes: [],
		};
	}

	if (p.indexOf(GENERIC_ICLOUD) !== -1) {
		return {
			code: 'wrong-icloud-folder',
			ok: false,
			syncing: true,
			title: 'Vault is in iCloud Drive, but not in the folder mobile Obsidian reads',
			detail:
				'iCloud is syncing these files, which is why they appear in the Files app — but Obsidian on iPhone and iPad only lists vaults from its own container. This is the single most common reason a Mac vault never shows up on iOS.',
			fixes: [
				'On the iPhone, open Obsidian and create a new vault with "Store in iCloud" turned on. That is what creates the container folder — a folder you make by hand will not work.',
				'Back on the Mac, copy this vault into iCloud Drive → Obsidian.',
				'Open the copy with "Open folder as vault", then retire the old location.',
			],
		};
	}

	if (p.indexOf(MOBILE_DOCUMENTS) !== -1) {
		return {
			code: 'other-icloud-container',
			ok: false,
			syncing: true,
			title: 'Vault is in another app\'s iCloud container',
			detail:
				'This path belongs to a different app. Obsidian on mobile cannot reach it.',
			fixes: ['Copy the vault into iCloud Drive → Obsidian.'],
		};
	}

	if (/\/(Documents|Desktop)(\/|$)/.test(p) && /\/Users\//.test(p)) {
		return {
			code: 'desktop-documents',
			ok: false,
			syncing: false,
			title: 'Vault is in your local Documents or Desktop folder',
			detail:
				'Even with "Desktop & Documents Folders" enabled in iCloud settings, Obsidian on mobile will not find a vault here. It only reads its own container.',
			fixes: ['Copy the vault into iCloud Drive → Obsidian.'],
		};
	}

	return {
		code: 'local-only',
		ok: false,
		syncing: false,
		title: 'Vault is stored locally and is not syncing',
		detail:
			'Nothing is replicating this folder, so changes stay on this Mac.',
		fixes: ['Copy the vault into iCloud Drive → Obsidian.'],
	};
}

/**
 * Terminal commands that move a vault into the folder mobile Obsidian reads.
 * A backup runs first and the original is never deleted.
 */
function buildMigrationPlan(basePath, vaultName) {
	const name = vaultName || 'MyVault';
	const src = String(basePath || '/path/to/vault').replace(/\/+$/, '');
	const target = CONTAINER_SHELL_PATH + '/' + name;
	const lines = [
		'# 1. Back up first. Never skip this.',
		'cp -R "' + src + '" "$HOME/Desktop/' + name + '-backup-$(date +%Y%m%d-%H%M)"',
		'',
		'# 2. Copy the vault into the folder Obsidian on iOS reads from.',
		'#    If mkdir fails, create a vault on your iPhone with "Store in iCloud"',
		'#    first — only the app can create this container correctly.',
		'mkdir -p "' + CONTAINER_SHELL_PATH + '"',
		'cp -R "' + src + '" "' + target + '"',
		'',
		'# 3. Force iCloud to keep a full local copy. Obsidian cannot read',
		'#    placeholder files that have been offloaded to save disk space.',
		'brctl download "' + target + '"',
	];
	return {
		container: CONTAINER_SHELL_PATH,
		target: target,
		shell: lines.join('\n'),
		steps: [
			'Run the commands below in Terminal.',
			'In Obsidian, choose "Open folder as vault" and pick iCloud Drive → Obsidian → ' +
				name +
				'.',
			'Wait for the first sync to finish before editing on a second device.',
			'On the iPhone, open the same vault and compare fingerprints in the jemzsync panel.',
		],
	};
}

/* ---------------------- placeholder files ---------------------- */

const PLACEHOLDER_RE = /^\.(.+)\.icloud$/;

/** True for the `.Note.md.icloud` stubs iCloud leaves when a file is offloaded. */
function isPlaceholder(name) {
	return PLACEHOLDER_RE.test(String(name || ''));
}

/** `.Note.md.icloud` → `Note.md`. Returns null for anything else. */
function placeholderTarget(name) {
	const m = String(name || '').match(PLACEHOLDER_RE);
	return m ? m[1] : null;
}

/* ---------------------- path helpers ---------------------- */

function splitPath(p) {
	const clean = String(p || '').replace(/^\/+/, '');
	const slash = clean.lastIndexOf('/');
	const dir = slash === -1 ? '' : clean.slice(0, slash);
	const base = slash === -1 ? clean : clean.slice(slash + 1);
	const dot = base.lastIndexOf('.');
	const hasExt = dot > 0;
	return {
		dir: dir,
		base: base,
		stem: hasExt ? base.slice(0, dot) : base,
		ext: hasExt ? base.slice(dot) : '',
	};
}

function joinPath(dir, base) {
	return dir ? dir + '/' + base : base;
}

/* ---------------------- conflict detection ---------------------- */

const CONFLICT_PATTERNS = [
	{
		id: 'icloud-numbered',
		label: 'iCloud duplicate',
		re: /^(.*\S)\s(\d+)$/,
		// Only a conflict when the un-numbered original also exists in the same
		// folder. Without this, every "Chapter 2.md" would be flagged.
		requiresOriginal: true,
	},
	{
		id: 'conflicted-copy',
		label: 'Conflicted copy',
		re: /^(.*?)\s*\([^)]*conflicted copy[^)]*\)$/i,
		requiresOriginal: false,
	},
	{
		id: 'sync-conflict',
		label: 'Sync conflict',
		re: /^(.*?)\.sync-conflict-.*$/i,
		requiresOriginal: false,
	},
];

/**
 * Group duplicate files that a sync engine created alongside an original.
 *
 * `Chapter 2.md` is only flagged when `Chapter.md` also exists in the same
 * folder — otherwise every numbered note in a vault would be a false positive.
 *
 * @param {string[]} paths vault-relative paths
 * @returns {Array<{original: string, copies: Array<{path: string, label: string, patternId: string}>}>}
 */
function findConflicts(paths) {
	const set = Object.create(null);
	for (let i = 0; i < paths.length; i++) set[paths[i]] = true;

	const groups = Object.create(null);

	for (let i = 0; i < paths.length; i++) {
		const path = paths[i];
		const parts = splitPath(path);

		for (let j = 0; j < CONFLICT_PATTERNS.length; j++) {
			const pat = CONFLICT_PATTERNS[j];
			const m = parts.stem.match(pat.re);
			if (!m) continue;

			const originalStem = m[1];
			if (!originalStem || originalStem === parts.stem) continue;

			const originalPath = joinPath(parts.dir, originalStem + parts.ext);
			if (pat.requiresOriginal && !set[originalPath]) continue;
			if (originalPath === path) continue;

			if (!groups[originalPath]) groups[originalPath] = [];
			groups[originalPath].push({
				path: path,
				label: pat.label,
				patternId: pat.id,
			});
			break;
		}
	}

	const out = [];
	const keys = Object.keys(groups).sort();
	for (let i = 0; i < keys.length; i++) {
		out.push({
			original: keys[i],
			originalExists: !!set[keys[i]],
			copies: groups[keys[i]].sort(function (a, b) {
				return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
			}),
		});
	}
	return out;
}

/**
 * Pick which version of a conflicted file to keep: newest wins, then largest,
 * then the original path as a stable tiebreak.
 *
 * @param {Array<{path: string, mtime: number, size: number, isOriginal?: boolean}>} entries
 */
function chooseWinner(entries) {
	if (!entries || !entries.length) return null;
	let best = entries[0];
	for (let i = 1; i < entries.length; i++) {
		const e = entries[i];
		if (e.mtime > best.mtime) best = e;
		else if (e.mtime === best.mtime) {
			if (e.size > best.size) best = e;
			else if (e.size === best.size && e.isOriginal && !best.isOriginal) best = e;
		}
	}
	return best;
}

/** Stitch two conflicting versions into one note rather than discarding either. */
function buildMergedContent(originalText, copyText, meta) {
	meta = meta || {};
	const from = meta.copyPath || 'conflicted copy';
	const when = meta.when || '';
	if (String(originalText).trim() === String(copyText).trim()) {
		return { changed: false, text: originalText };
	}
	const banner =
		'\n\n---\n\n> [!warning] Merged by jemzsync' +
		(when ? ' on ' + when : '') +
		'\n> The text below came from `' +
		from +
		'`. Delete this block once you have kept what you want.\n\n';
	return { changed: true, text: String(originalText) + banner + String(copyText) };
}

/* ---------------------- fingerprint ---------------------- */

/** FNV-1a. Small, dependency-free, and identical on every device. */
function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i) & 0xff;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

function toHex8(n) {
	const s = (n >>> 0).toString(16);
	return '00000000'.slice(s.length) + s;
}

/**
 * Reduce a vault to a short string two devices can compare by eye.
 *
 * Only path and size feed the digest. Modification times drift between devices
 * for reasons that have nothing to do with content, so including them would
 * make matching vaults look different.
 */
function computeFingerprint(entries, opts) {
	opts = opts || {};
	const excludePrefixes = opts.excludePrefixes || [];
	const excludeNames = opts.excludeNames || [];

	const kept = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const parts = splitPath(e.path);
		if (isPlaceholder(parts.base)) continue;
		if (excludeNames.indexOf(parts.base) !== -1) continue;
		let skip = false;
		for (let j = 0; j < excludePrefixes.length; j++) {
			if (e.path.indexOf(excludePrefixes[j]) === 0) {
				skip = true;
				break;
			}
		}
		if (skip) continue;
		kept.push(e);
	}

	kept.sort(function (a, b) {
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});

	let hA = 0x811c9dc5;
	let bytes = 0;
	let newest = 0;
	for (let i = 0; i < kept.length; i++) {
		const e = kept[i];
		hA ^= fnv1a(e.path + ':' + (e.size || 0));
		hA = Math.imul(hA, 0x01000193) >>> 0;
		bytes += e.size || 0;
		if (e.mtime && e.mtime > newest) newest = e.mtime;
	}

	return {
		files: kept.length,
		bytes: bytes,
		newest: newest,
		digest: toHex8(hA) + '-' + toHex8(fnv1a(kept.length + ':' + bytes)),
	};
}

/** Human-readable comparison of two fingerprints. */
function compareFingerprints(a, b) {
	if (!a || !b) {
		return { match: false, summary: 'Nothing to compare yet.' };
	}
	if (a.digest === b.digest) {
		return {
			match: true,
			summary:
				'Match. Both devices hold the same ' + a.files + ' files. Sync is working.',
		};
	}
	const diff = (b.files || 0) - (a.files || 0);
	let summary = 'No match — the two devices are holding different files. ';
	if (diff > 0) summary += 'The other device has ' + diff + ' more.';
	else if (diff < 0) summary += 'This device has ' + -diff + ' more.';
	else summary += 'Same file count, so some file differs in size.';
	summary += ' Give iCloud a few minutes, then scan again.';
	return { match: false, summary: summary };
}

/* ---------------------- device beacons ---------------------- *
 *
 * How devices see each other without any server:
 * every device writes one small JSON file into `.jemzsync/` inside the vault.
 * iCloud carries that file to the other devices along with the notes, so each
 * device can list who else is in this vault, when they last scanned, and
 * whether their files match. The beacon arriving at all is itself proof that
 * sync is flowing in that direction.
 */

function newDeviceId(rand) {
	rand = rand || Math.random;
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let s = '';
	for (let i = 0; i < 8; i++) {
		s += chars[Math.floor(rand() * chars.length) % chars.length];
	}
	return s;
}

function isBeaconPath(path) {
	const p = String(path || '');
	return p.indexOf(BEACON_PREFIX) === 0 && /\.json$/.test(p);
}

function makeBeacon(identity, fingerprint, now, pluginVersion) {
	return {
		kind: 'jemzsync-beacon',
		id: identity.id,
		name: identity.name,
		platform: identity.platform || '',
		updatedAt: now,
		pluginVersion: pluginVersion || '',
		fingerprint: {
			digest: fingerprint.digest,
			files: fingerprint.files,
			bytes: fingerprint.bytes,
		},
	};
}

/** Tolerant parser — anything on disk might be truncated, foreign, or garbage. */
function parseBeacon(text) {
	let obj;
	try {
		obj = JSON.parse(String(text));
	} catch (_) {
		return { ok: false };
	}
	if (!obj || obj.kind !== 'jemzsync-beacon') return { ok: false };
	if (typeof obj.id !== 'string' || !obj.id) return { ok: false };
	if (!obj.fingerprint || typeof obj.fingerprint.digest !== 'string') {
		return { ok: false };
	}
	return {
		ok: true,
		beacon: {
			id: obj.id,
			name: typeof obj.name === 'string' && obj.name ? obj.name : 'Unknown device',
			platform: typeof obj.platform === 'string' ? obj.platform : '',
			updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
			pluginVersion: typeof obj.pluginVersion === 'string' ? obj.pluginVersion : '',
			fingerprint: {
				digest: obj.fingerprint.digest,
				files: Number(obj.fingerprint.files) || 0,
				bytes: Number(obj.fingerprint.bytes) || 0,
			},
		},
	};
}

/** Separate this device's own beacon from everyone else's. */
function splitBeacons(beacons, selfId) {
	const mine = [];
	const others = [];
	for (let i = 0; i < beacons.length; i++) {
		const b = beacons[i];
		if (b.id === selfId) mine.push(b);
		else others.push(b);
	}
	mine.sort(function (a, b) {
		return (b.updatedAt || 0) - (a.updatedAt || 0);
	});
	others.sort(function (a, b) {
		const an = a.name + a.id;
		const bn = b.name + b.id;
		return an < bn ? -1 : an > bn ? 1 : 0;
	});
	return { self: mine.length ? mine[0] : null, others: others };
}

/** Rewrite our beacon only when it would say something new. */
function shouldWriteBeacon(prev, digest, now, minIntervalMs) {
	if (!prev) return true;
	if (!prev.fingerprint || prev.fingerprint.digest !== digest) return true;
	if (now - (prev.updatedAt || 0) >= minIntervalMs) return true;
	return false;
}

/** Per-device status lines for the panel. */
function summarizeDevices(others, localFingerprint, now, staleMs) {
	staleMs = staleMs || BEACON_STALE_MS;
	const out = [];
	for (let i = 0; i < others.length; i++) {
		const b = others[i];
		const cmp = compareFingerprints(localFingerprint, b.fingerprint);
		out.push({
			id: b.id,
			name: b.name,
			platform: b.platform,
			updatedAt: b.updatedAt,
			stale: now - (b.updatedAt || 0) > staleMs,
			match: cmp.match,
			summary: cmp.summary,
			files: b.fingerprint.files,
			bytes: b.fingerprint.bytes,
		});
	}
	return out;
}

function formatBytes(n) {
	const units = ['B', 'KB', 'MB', 'GB'];
	let v = Number(n) || 0;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u++;
	}
	return (u === 0 ? v : v.toFixed(1)) + ' ' + units[u];
}

/**
 * Turn a completed scan into the one-line verdict shown in the status bar.
 */
function summarizeScan(scan) {
	if (!scan) return { level: 'idle', text: 'jemzsync: not scanned' };
	if (scan.conflicts && scan.conflicts.length) {
		return {
			level: 'warn',
			text:
				'jemzsync: ' +
				scan.conflicts.length +
				' conflict' +
				(scan.conflicts.length === 1 ? '' : 's'),
		};
	}
	if (scan.placeholders && scan.placeholders.length) {
		return {
			level: 'warn',
			text: 'jemzsync: ' + scan.placeholders.length + ' files not downloaded',
		};
	}
	if (scan.location && !scan.location.ok) {
		return { level: 'warn', text: 'jemzsync: check setup' };
	}
	return { level: 'ok', text: 'jemzsync: ' + scan.fingerprint.files + ' files synced' };
}

const CORE = {
	classifyVaultLocation: classifyVaultLocation,
	buildMigrationPlan: buildMigrationPlan,
	isPlaceholder: isPlaceholder,
	placeholderTarget: placeholderTarget,
	splitPath: splitPath,
	joinPath: joinPath,
	findConflicts: findConflicts,
	chooseWinner: chooseWinner,
	buildMergedContent: buildMergedContent,
	computeFingerprint: computeFingerprint,
	compareFingerprints: compareFingerprints,
	summarizeScan: summarizeScan,
	formatBytes: formatBytes,
	fnv1a: fnv1a,
	newDeviceId: newDeviceId,
	isBeaconPath: isBeaconPath,
	makeBeacon: makeBeacon,
	parseBeacon: parseBeacon,
	splitBeacons: splitBeacons,
	shouldWriteBeacon: shouldWriteBeacon,
	summarizeDevices: summarizeDevices,
	BEACON_DIR: BEACON_DIR,
	BEACON_MIN_INTERVAL_MS: BEACON_MIN_INTERVAL_MS,
	BEACON_STALE_MS: BEACON_STALE_MS,
	CONFLICT_PATTERNS: CONFLICT_PATTERNS,
	DEFAULT_SETTINGS: DEFAULT_SETTINGS,
};

/* ================================================================== *
 * SCANNER — walks the vault through Obsidian's adapter, which works
 * identically on macOS, iPadOS and iOS.
 * ================================================================== */

const MAX_FILES = 50000;

/**
 * @param {object} adapter an Obsidian DataAdapter (or a stand-in in tests)
 * @param {object} settings
 */
async function scanVault(adapter, settings) {
	settings = settings || DEFAULT_SETTINGS;
	const entries = [];
	const placeholders = [];
	const beaconPaths = [];
	const errors = [];
	let truncated = false;

	const queue = ['/'];
	const seen = Object.create(null);

	while (queue.length) {
		const dir = queue.shift();
		if (seen[dir]) continue;
		seen[dir] = true;

		let listing;
		try {
			listing = await adapter.list(dir);
		} catch (err) {
			errors.push({ path: dir, message: String((err && err.message) || err) });
			continue;
		}
		if (!listing) continue;

		const folders = listing.folders || [];
		for (let i = 0; i < folders.length; i++) {
			const f = folders[i];
			const base = splitPath(f).base;
			if (base === '.trash' || base === '.git') continue;
			queue.push(f);
		}

		const files = listing.files || [];
		for (let i = 0; i < files.length; i++) {
			const path = files[i].replace(/^\/+/, '');
			const base = splitPath(path).base;

			if (isBeaconPath(path)) beaconPaths.push(path);

			if (isPlaceholder(base)) {
				placeholders.push({
					path: path,
					expects: joinPath(splitPath(path).dir, placeholderTarget(base)),
				});
				continue;
			}

			if (entries.length >= MAX_FILES) {
				truncated = true;
				continue;
			}

			let stat = null;
			try {
				stat = await adapter.stat(path);
			} catch (err) {
				errors.push({ path: path, message: String((err && err.message) || err) });
			}
			entries.push({
				path: path,
				size: (stat && stat.size) || 0,
				mtime: (stat && stat.mtime) || 0,
			});
		}
	}

	const fingerprint = computeFingerprint(entries, {
		excludePrefixes: settings.excludePrefixes,
		excludeNames: settings.excludeNames,
	});

	// Conflicts inside excluded folders (.jemzsync beacons, per-device
	// workspace files) are sync-engine noise, not note conflicts.
	const conflictInput = [];
	for (let i = 0; i < entries.length; i++) {
		const path = entries[i].path;
		let skip = false;
		const prefixes = settings.excludePrefixes || [];
		for (let j = 0; j < prefixes.length; j++) {
			if (path.indexOf(prefixes[j]) === 0) {
				skip = true;
				break;
			}
		}
		if (!skip) conflictInput.push(path);
	}
	const conflicts = findConflicts(conflictInput);

	const byPath = Object.create(null);
	for (let i = 0; i < entries.length; i++) byPath[entries[i].path] = entries[i];

	return {
		at: Date.now(),
		entries: entries,
		byPath: byPath,
		placeholders: placeholders,
		beaconPaths: beaconPaths,
		conflicts: conflicts,
		fingerprint: fingerprint,
		errors: errors,
		truncated: truncated,
	};
}

CORE.scanVault = scanVault;

/* ================================================================== *
 * OBSIDIAN INTEGRATION
 * ================================================================== */

const Plugin = ob.Plugin;
const PluginSettingTab = ob.PluginSettingTab;
const ItemView = ob.ItemView;
const Setting = ob.Setting;
const Notice = ob.Notice;
const Platform = ob.Platform;

function currentPlatform() {
	if (Platform && Platform.isMobileApp) return 'mobile';
	if (Platform && Platform.isDesktopApp) return 'desktop';
	return 'unknown';
}

/** A friendly default label for this device, refined per Apple device type. */
function defaultDeviceName() {
	if (Platform && Platform.isPhone) return 'iPhone';
	if (Platform && Platform.isTablet) return 'iPad';
	if (Platform && Platform.isMacOS && Platform.isDesktopApp) return 'Mac';
	if (Platform && Platform.isDesktopApp) return 'Desktop';
	if (Platform && Platform.isMobileApp) return 'Mobile';
	return 'Device';
}

/**
 * Identity lives in localStorage, which is per app install and never syncs.
 * That matters: the vault (including plugin settings) is shared through
 * iCloud, so anything stored there would give every device the same ID.
 */
function loadDeviceIdentity() {
	let store = null;
	try {
		store = typeof localStorage !== 'undefined' ? localStorage : null;
	} catch (_) {
		store = null;
	}

	let id = null;
	let name = null;
	if (store) {
		try {
			id = store.getItem('jemzsync-device-id');
			if (!id) {
				id = newDeviceId();
				store.setItem('jemzsync-device-id', id);
			}
			name = store.getItem('jemzsync-device-name');
		} catch (_) {
			/* private mode or quota — fall back to ephemeral */
		}
	}
	if (!id) id = newDeviceId();
	if (!name) name = defaultDeviceName();
	return { id: id, name: name, platform: defaultDeviceName() };
}

function saveDeviceName(name) {
	try {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('jemzsync-device-name', name);
		}
	} catch (_) {
		/* best effort */
	}
}

/** Read the vault path without touching Node APIs — it is a plain property. */
function vaultBasePath(app) {
	try {
		const adapter = app.vault.adapter;
		if (adapter && typeof adapter.getBasePath === 'function') {
			return adapter.getBasePath();
		}
		if (adapter && typeof adapter.basePath === 'string') return adapter.basePath;
	} catch (_) {
		/* mobile adapters expose neither */
	}
	return null;
}

function timeAgo(ts) {
	if (!ts) return 'never';
	const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (secs < 60) return secs + 's ago';
	if (secs < 3600) return Math.round(secs / 60) + 'm ago';
	if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
	return Math.round(secs / 86400) + 'd ago';
}

class JemzSyncPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.lastScan = null;
		this.identity = loadDeviceIdentity();

		this.registerView(
			VIEW_TYPE_JEMZSYNC,
			(leaf) => new JemzSyncView(leaf, this)
		);

		this.addRibbonIcon('cloud', 'Open jemzsync', () => {
			this.activateView();
		});

		if (this.settings.showStatusBar) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.setText('jemzsync: not scanned');
		}

		this.addCommand({
			id: 'open-panel',
			name: 'Open panel',
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: 'check-setup',
			name: 'Check iCloud setup',
			callback: async () => {
				await this.runScan(true);
				await this.activateView();
			},
		});

		this.addCommand({
			id: 'scan-conflicts',
			name: 'Scan for sync conflicts',
			callback: async () => {
				const scan = await this.runScan(false);
				new Notice(
					scan.conflicts.length
						? 'Found ' + scan.conflicts.length + ' conflicted file(s).'
						: 'No sync conflicts found.'
				);
				await this.activateView();
			},
		});

		this.addCommand({
			id: 'copy-fingerprint',
			name: 'Copy vault fingerprint',
			callback: async () => {
				const scan = this.lastScan || (await this.runScan(false));
				await navigator.clipboard.writeText(scan.fingerprint.digest);
				new Notice('Fingerprint copied. Paste it on your other device.');
			},
		});

		this.addSettingTab(new JemzSyncSettingTab(this.app, this));

		if (this.settings.scanOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				this.runScan(false).catch(() => {});
			});
		}

		if (this.settings.autoScanMinutes > 0) {
			this.registerInterval(
				window.setInterval(() => {
					this.runScan(false).catch(() => {});
				}, this.settings.autoScanMinutes * 60 * 1000)
			);
		}
	}

	onunload() {
		/* Obsidian detaches leaves and intervals registered above. */
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_JEMZSYNC);
		if (existing.length) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_JEMZSYNC, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async runScan(notify) {
		const scan = await scanVault(this.app.vault.adapter, this.settings);
		scan.location = classifyVaultLocation(vaultBasePath(this.app), {
			platform: currentPlatform(),
			vaultName: this.app.vault.getName(),
		});
		await this.syncBeacons(scan);
		this.lastScan = scan;

		const summary = summarizeScan(scan);
		if (this.statusEl) this.statusEl.setText(summary.text);

		if (notify) new Notice(summary.text.replace('jemzsync: ', ''));
		else if (this.settings.notifyOnConflicts && scan.conflicts.length) {
			new Notice(
				'jemzsync found ' + scan.conflicts.length + ' conflicted file(s).'
			);
		}

		this.refreshViews();
		return scan;
	}

	refreshViews() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_JEMZSYNC);
		for (let i = 0; i < leaves.length; i++) {
			const view = leaves[i].view;
			if (view && typeof view.render === 'function') view.render();
		}
	}

	/**
	 * Read every device's beacon out of the vault, then refresh our own.
	 * Never lets a beacon problem break the scan — this is all best-effort.
	 */
	async syncBeacons(scan) {
		scan.devices = [];
		try {
			const adapter = this.app.vault.adapter;
			const beacons = [];
			for (let i = 0; i < scan.beaconPaths.length; i++) {
				try {
					const parsed = parseBeacon(await adapter.read(scan.beaconPaths[i]));
					if (parsed.ok) beacons.push(parsed.beacon);
				} catch (_) {
					/* unreadable beacon — perhaps mid-sync; skip it */
				}
			}

			const split = splitBeacons(beacons, this.identity.id);
			scan.devices = summarizeDevices(split.others, scan.fingerprint, Date.now());

			if (this.settings.writeBeacon) {
				const due = shouldWriteBeacon(
					split.self,
					scan.fingerprint.digest,
					Date.now(),
					BEACON_MIN_INTERVAL_MS
				);
				if (due) await this.writeOwnBeacon(scan.fingerprint);
			}
		} catch (_) {
			/* beacons are an extra; the scan result stands without them */
		}
	}

	async writeOwnBeacon(fingerprint) {
		const adapter = this.app.vault.adapter;
		try {
			const exists = await adapter.exists(BEACON_DIR);
			if (!exists) await adapter.mkdir(BEACON_DIR);
		} catch (_) {
			/* mkdir races with iCloud creating it — either way it exists now */
		}
		const beacon = makeBeacon(
			this.identity,
			fingerprint,
			Date.now(),
			(this.manifest && this.manifest.version) || ''
		);
		await adapter.write(
			BEACON_DIR + '/device-' + this.identity.id + '.json',
			JSON.stringify(beacon, null, 2)
		);
	}

	/** Keep the newest version of a conflicted file and trash the rest. */
	async resolveKeepNewest(group) {
		const candidates = [];
		const scan = this.lastScan;
		if (!scan) return { ok: false, message: 'Run a scan first.' };

		if (scan.byPath[group.original]) {
			const e = scan.byPath[group.original];
			candidates.push({
				path: e.path,
				mtime: e.mtime,
				size: e.size,
				isOriginal: true,
			});
		}
		for (let i = 0; i < group.copies.length; i++) {
			const e = scan.byPath[group.copies[i].path];
			if (e) candidates.push({ path: e.path, mtime: e.mtime, size: e.size });
		}
		if (candidates.length < 2) {
			return { ok: false, message: 'Nothing left to resolve.' };
		}

		const winner = chooseWinner(candidates);
		const winnerText = await this.app.vault.adapter.read(winner.path);

		if (winner.path !== group.original) {
			await this.app.vault.adapter.write(group.original, winnerText);
		}

		let trashed = 0;
		for (let i = 0; i < candidates.length; i++) {
			const path = candidates[i].path;
			if (path === group.original) continue;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file) {
				await this.app.fileManager.trashFile(file);
				trashed++;
			}
		}

		await this.runScan(false);
		return {
			ok: true,
			message:
				'Kept ' +
				(winner.path === group.original ? 'the original' : winner.path) +
				' and moved ' +
				trashed +
				' duplicate(s) to trash.',
		};
	}

	/** Append every conflicting version into the original so nothing is lost. */
	async resolveMerge(group) {
		const scan = this.lastScan;
		if (!scan) return { ok: false, message: 'Run a scan first.' };

		let text = '';
		try {
			text = await this.app.vault.adapter.read(group.original);
		} catch (_) {
			text = '';
		}

		const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
		let merged = 0;

		for (let i = 0; i < group.copies.length; i++) {
			const copyPath = group.copies[i].path;
			let copyText;
			try {
				copyText = await this.app.vault.adapter.read(copyPath);
			} catch (_) {
				continue;
			}
			const result = buildMergedContent(text, copyText, {
				copyPath: copyPath,
				when: when,
			});
			text = result.text;
			if (result.changed) merged++;

			const file = this.app.vault.getAbstractFileByPath(copyPath);
			if (file) await this.app.fileManager.trashFile(file);
		}

		await this.app.vault.adapter.write(group.original, text);
		await this.runScan(false);
		return {
			ok: true,
			message:
				merged > 0
					? 'Merged ' + merged + ' version(s) into ' + group.original + '.'
					: 'Versions were identical — kept one copy.',
		};
	}
}

/* ---------------------- sidebar view ---------------------- */

class JemzSyncView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_JEMZSYNC;
	}
	getDisplayText() {
		return 'jemzsync';
	}
	getIcon() {
		return 'cloud';
	}

	async onOpen() {
		this.render();
	}

	render() {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass('jemzsync-panel');

		const scan = this.plugin.lastScan;

		const header = root.createDiv({ cls: 'jemzsync-header' });
		header.createEl('h3', { text: 'jemzsync' });
		header.createEl('div', {
			cls: 'jemzsync-sub',
			text:
				'Last scan: ' + (scan ? timeAgo(scan.at) : 'never') + ' · iCloud Drive',
		});

		const actions = root.createDiv({ cls: 'jemzsync-actions' });
		const scanBtn = actions.createEl('button', { text: 'Scan now' });
		scanBtn.addEventListener('click', async () => {
			scanBtn.disabled = true;
			scanBtn.setText('Scanning…');
			try {
				await this.plugin.runScan(false);
			} finally {
				scanBtn.disabled = false;
			}
		});

		if (!scan) {
			root.createEl('p', {
				cls: 'jemzsync-empty',
				text: 'Scan to check whether this vault is set up to sync across your Apple devices.',
			});
			return;
		}

		this.renderLocation(root, scan);
		this.renderDevices(root, scan);
		this.renderFingerprint(root, scan);
		this.renderPlaceholders(root, scan);
		this.renderConflicts(root, scan);
	}

	renderDevices(root, scan) {
		const devices = scan.devices || [];
		const card = root.createDiv({
			cls:
				'jemzsync-card ' +
				(devices.length && devices.every((d) => d.match || d.stale)
					? 'is-ok'
					: devices.some((d) => !d.match && !d.stale)
					? 'is-warn'
					: ''),
		});
		card.createEl('div', { cls: 'jemzsync-card-title', text: 'Devices' });

		const me = card.createDiv({ cls: 'jemzsync-device' });
		me.createEl('div', {
			cls: 'jemzsync-device-name',
			text: this.plugin.identity.name + ' — this device',
		});
		me.createEl('div', {
			cls: 'jemzsync-device-meta',
			text: scan.fingerprint.files + ' files · ' + formatBytes(scan.fingerprint.bytes),
		});

		if (!devices.length) {
			card.createEl('p', {
				cls: 'jemzsync-card-body',
				text: 'No other devices seen yet. Enable jemzsync in this same vault on your iPhone or iPad — each device announces itself through iCloud and appears here on its own. The announcement travelling across is itself proof that sync is flowing.',
			});
			return;
		}

		for (let i = 0; i < devices.length; i++) {
			const d = devices[i];
			const row = card.createDiv({ cls: 'jemzsync-device' });
			row.createEl('div', {
				cls: 'jemzsync-device-name',
				text: d.name + (d.platform && d.platform !== d.name ? ' · ' + d.platform : ''),
			});
			row.createEl('div', {
				cls: 'jemzsync-device-meta',
				text:
					d.files +
					' files · last announce ' +
					timeAgo(d.updatedAt) +
					(d.stale ? ' · quiet for a while' : ''),
			});
			row.createEl('div', {
				cls: 'jemzsync-compare ' + (d.match ? 'is-ok' : d.stale ? '' : 'is-warn'),
				text: d.match
					? 'Same files as this device.'
					: d.stale
					? 'Last known state differed, but this device has been quiet — open Obsidian there to refresh.'
					: d.summary,
			});
		}
	}

	renderLocation(root, scan) {
		const loc = scan.location;
		if (!loc) return;

		const card = root.createDiv({
			cls: 'jemzsync-card ' + (loc.ok ? 'is-ok' : 'is-warn'),
		});
		card.createEl('div', { cls: 'jemzsync-card-title', text: loc.title });
		card.createEl('p', { cls: 'jemzsync-card-body', text: loc.detail });

		if (loc.fixes && loc.fixes.length) {
			const ol = card.createEl('ol', { cls: 'jemzsync-fixes' });
			for (let i = 0; i < loc.fixes.length; i++) {
				ol.createEl('li', { text: loc.fixes[i] });
			}
		}

		const needsMigration =
			!loc.ok &&
			currentPlatform() === 'desktop' &&
			['wrong-icloud-folder', 'local-only', 'desktop-documents', 'other-icloud-container'].indexOf(
				loc.code
			) !== -1;

		if (needsMigration) {
			const basePath = vaultBasePath(this.plugin.app);
			const plan = buildMigrationPlan(basePath, this.plugin.app.vault.getName());
			const pre = card.createEl('pre', { cls: 'jemzsync-shell' });
			pre.createEl('code', { text: plan.shell });
			const copy = card.createEl('button', { text: 'Copy commands' });
			copy.addEventListener('click', async () => {
				await navigator.clipboard.writeText(plan.shell);
				new Notice('Commands copied. Paste them into Terminal.');
			});
		}
	}

	renderFingerprint(root, scan) {
		const fp = scan.fingerprint;
		const card = root.createDiv({ cls: 'jemzsync-card' });
		card.createEl('div', {
			cls: 'jemzsync-card-title',
			text: 'Vault fingerprint',
		});
		card.createEl('p', {
			cls: 'jemzsync-card-body',
			text: 'Run a scan on each device. Matching fingerprints mean the same files are on both.',
		});

		const code = card.createEl('div', { cls: 'jemzsync-fingerprint' });
		code.setText(fp.digest);

		card.createEl('div', {
			cls: 'jemzsync-meta',
			text: fp.files + ' files · ' + formatBytes(fp.bytes),
		});

		const row = card.createDiv({ cls: 'jemzsync-actions' });
		const copyBtn = row.createEl('button', { text: 'Copy' });
		copyBtn.addEventListener('click', async () => {
			await navigator.clipboard.writeText(fp.digest);
			new Notice('Fingerprint copied.');
		});

		const saved = this.plugin.settings.pairedFingerprint;
		if (saved) {
			const cmp = compareFingerprints({ digest: saved, files: fp.files }, fp);
			card.createEl('div', {
				cls: 'jemzsync-compare ' + (cmp.match ? 'is-ok' : 'is-warn'),
				text:
					(this.plugin.settings.pairedDeviceLabel || 'Other device') +
					': ' +
					cmp.summary,
			});
		}
	}

	renderPlaceholders(root, scan) {
		if (!scan.placeholders.length) return;
		const card = root.createDiv({ cls: 'jemzsync-card is-warn' });
		card.createEl('div', {
			cls: 'jemzsync-card-title',
			text: scan.placeholders.length + ' files are not downloaded',
		});
		card.createEl('p', {
			cls: 'jemzsync-card-body',
			text: 'iCloud offloaded these to save space, so Obsidian cannot read them. In Finder, right-click the Obsidian folder in iCloud Drive and choose "Keep Downloaded". On iPhone, open the vault folder in Files and pull down to download.',
		});
		const list = card.createEl('ul', { cls: 'jemzsync-list' });
		for (let i = 0; i < Math.min(10, scan.placeholders.length); i++) {
			list.createEl('li', { text: scan.placeholders[i].expects });
		}
	}

	renderConflicts(root, scan) {
		const card = root.createDiv({
			cls: 'jemzsync-card ' + (scan.conflicts.length ? 'is-warn' : 'is-ok'),
		});
		card.createEl('div', {
			cls: 'jemzsync-card-title',
			text: scan.conflicts.length
				? scan.conflicts.length + ' conflicted files'
				: 'No conflicts',
		});

		if (!scan.conflicts.length) {
			card.createEl('p', {
				cls: 'jemzsync-card-body',
				text: 'iCloud has not left duplicate copies behind.',
			});
			return;
		}

		card.createEl('p', {
			cls: 'jemzsync-card-body',
			text: 'iCloud makes a second copy when two devices edit a note before seeing each other. Pick which version survives.',
		});

		for (let i = 0; i < scan.conflicts.length; i++) {
			const group = scan.conflicts[i];
			const row = card.createDiv({ cls: 'jemzsync-conflict' });
			row.createEl('div', { cls: 'jemzsync-conflict-name', text: group.original });
			for (let j = 0; j < group.copies.length; j++) {
				row.createEl('div', {
					cls: 'jemzsync-conflict-copy',
					text: group.copies[j].path + '  (' + group.copies[j].label + ')',
				});
			}

			const btns = row.createDiv({ cls: 'jemzsync-actions' });

			const keepBtn = btns.createEl('button', { text: 'Keep newest' });
			keepBtn.addEventListener('click', async () => {
				const res = await this.plugin.resolveKeepNewest(group);
				new Notice(res.message);
			});

			const mergeBtn = btns.createEl('button', { text: 'Merge both' });
			mergeBtn.addEventListener('click', async () => {
				const res = await this.plugin.resolveMerge(group);
				new Notice(res.message);
			});

			const openBtn = btns.createEl('button', { text: 'Open' });
			openBtn.addEventListener('click', async () => {
				const file = this.plugin.app.vault.getAbstractFileByPath(group.original);
				if (file) await this.plugin.app.workspace.getLeaf(true).openFile(file);
			});
		}
	}
}

/* ---------------------- settings ---------------------- */

class JemzSyncSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('This device\'s name')
			.setDesc(
				'How this device introduces itself to your other devices. Stored on this device only.'
			)
			.addText((t) =>
				t
					.setPlaceholder(defaultDeviceName())
					.setValue(this.plugin.identity.name)
					.onChange((v) => {
						const name = v.trim() || defaultDeviceName();
						this.plugin.identity.name = name;
						saveDeviceName(name);
						this.plugin.refreshViews();
					})
			);

		new Setting(containerEl)
			.setName('Announce this device')
			.setDesc(
				'Writes one small file into a hidden .jemzsync folder in the vault so your other devices can see this one and confirm the files match.'
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.writeBeacon).onChange(async (v) => {
					this.plugin.settings.writeBeacon = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Scan when Obsidian starts')
			.setDesc('Check the vault as soon as the app is ready.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.scanOnStartup).onChange(async (v) => {
					this.plugin.settings.scanOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Scan every')
			.setDesc('Minutes between background scans. Set to 0 to scan only on demand.')
			.addText((t) =>
				t
					.setPlaceholder('15')
					.setValue(String(this.plugin.settings.autoScanMinutes))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.autoScanMinutes = isNaN(n) ? 0 : Math.max(0, n);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Notify about conflicts')
			.setDesc('Show a notice when a background scan finds duplicate copies.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.notifyOnConflicts).onChange(async (v) => {
					this.plugin.settings.notifyOnConflicts = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Show status bar item')
			.setDesc('Takes effect after Obsidian restarts.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showStatusBar).onChange(async (v) => {
					this.plugin.settings.showStatusBar = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Other device fingerprint')
			.setDesc(
				'Paste the fingerprint from your iPhone or iPad here to compare it against this vault.'
			)
			.addText((t) =>
				t
					.setPlaceholder('a1b2c3d4-e5f6a7b8')
					.setValue(this.plugin.settings.pairedFingerprint)
					.onChange(async (v) => {
						this.plugin.settings.pairedFingerprint = v.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		new Setting(containerEl)
			.setName('Other device name')
			.setDesc('A label so you remember which device that fingerprint came from.')
			.addText((t) =>
				t
					.setPlaceholder('iPhone')
					.setValue(this.plugin.settings.pairedDeviceLabel)
					.onChange(async (v) => {
						this.plugin.settings.pairedDeviceLabel = v.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);
	}
}

/* ------------------------------------------------------------------ *
 * Exports. Obsidian reads module.exports as the plugin class; the test
 * harness reaches for __core.
 * ------------------------------------------------------------------ */

module.exports = JemzSyncPlugin;
module.exports.default = JemzSyncPlugin;
module.exports.__core = CORE;
module.exports.VIEW_TYPE_JEMZSYNC = VIEW_TYPE_JEMZSYNC;
module.exports.PLUGIN_ID = PLUGIN_ID;
