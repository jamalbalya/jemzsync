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

/**
 * Where the vault is kept, and therefore what "set up correctly" means.
 *
 * The choice is per device, because each one has to know how it stores this
 * vault before it can read anything — in GitHub mode there is no synced
 * settings file to learn the answer from until after the first pull.
 */
const STORAGE_ECOSYSTEM = 'ecosystem';
const STORAGE_GITHUB = 'github';
const STORAGE_BOTH = 'both';

const STORAGE_MODES = [
	{
		id: STORAGE_ECOSYSTEM,
		/**
		 * Built from the ecosystem rather than patched with a string replace.
		 * The old version swapped the word "cloud" into a fixed sentence,
		 * which only produced the right text by accident of capitalisation.
		 */
		label: (eco) => "This device's " + eco.cloud + ' only',
		blurb: (eco) => eco.cloud + ' carries the vault, as it does today. GitHub is not used.',
	},
	{
		id: STORAGE_BOTH,
		label: () => 'Cloud and GitHub',
		blurb: (eco) =>
			eco.cloud +
			' carries the vault between devices, and GitHub additionally keeps a full history you can go back through.',
	},
	{
		id: STORAGE_GITHUB,
		label: () => 'GitHub only',
		blurb: () =>
			'GitHub carries the vault between devices. The vault can sit anywhere on disk. This is the option that works when your devices are in different ecosystems.',
	},
];

/** True when this mode talks to a repository at all. */
function storageUsesGithub(mode) {
	return mode === STORAGE_GITHUB || mode === STORAGE_BOTH;
}

/** True when the ecosystem's cloud is still expected to carry the vault. */
function storageUsesCloud(mode) {
	return mode !== STORAGE_GITHUB;
}

/**
 * Where this plugin's own files sit inside the vault.
 *
 * They must never count toward the vault fingerprint. Updating the plugin
 * changes the size of main.js, so a device on the new version and one still on
 * the old would compare their vaults and conclude they were out of sync — the
 * plugin reporting a sync failure that is nothing but its own upgrade. This is
 * the same self-reference problem as the beacons, and gets the same answer.
 */
const SELF_DIR = '.obsidian/plugins/jemzsync/';

/** Hidden folder inside the vault where each device announces itself. */
const BEACON_DIR = '.jemzsync';
const BEACON_PREFIX = '.jemzsync/device-';
/** Don't rewrite an unchanged beacon more often than this — avoids iCloud churn. */
const BEACON_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** A device silent for this long is shown as stale rather than out of sync. */
const BEACON_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * How long to wait after the last vault change before rescanning.
 *
 * Long enough that a burst of typing or a batch of files arriving from the
 * cloud collapses into one scan, short enough that the panel still feels live.
 */
const LIVE_SCAN_DEBOUNCE_MS = 8 * 1000;

/**
 * How long after the last edit to send changes to GitHub.
 *
 * Shorter than the scan debounce: a scan is cheap and local, whereas an
 * unsent edit is the half of the round trip that can actually lose work if
 * the device goes away. Still long enough that typing a paragraph is one
 * commit rather than forty.
 */
const GITHUB_SYNC_DEBOUNCE_MS = 10 * 1000;

/** The private iCloud container Obsidian owns. Mobile Obsidian only reads vaults from here. */
const OBSIDIAN_CONTAINER = 'iCloud~md~obsidian';
/** Generic iCloud Drive. A vault here syncs, but mobile Obsidian will not list it. */
const GENERIC_ICLOUD = 'com~apple~CloudDocs';
/** Root of every iCloud container on macOS. */
const MOBILE_DOCUMENTS = 'Library/Mobile Documents';

/** Shell-safe form of the folder mobile Obsidian reads from. */
const CONTAINER_SHELL_PATH =
	'$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents';

/**
 * Which cloud each ecosystem can actually keep a vault in.
 *
 * Apple is the strict one: mobile Obsidian reads a single private container,
 * so there is exactly one correct folder. Everywhere else the vault just has
 * to sit inside a folder that some desktop sync client is watching, which is
 * a looser test — any of the three big providers will do.
 *
 * The last three fields exist so that no message shown to every user has to
 * hardcode Apple's vocabulary. A Windows user was previously told to look in
 * Finder and to compare against "your iPhone or iPad"; anything user-facing
 * outside the Apple-only branches now reads its nouns from here instead.
 */
const ECOSYSTEMS = {
	apple: {
		id: 'apple',
		label: 'Apple',
		cloud: 'iCloud Drive',
		folderHint: 'iCloud Drive → Obsidian',
		/** What the OS calls its file browser. */
		fileManager: 'Finder',
		/** Mid-sentence description of the user's other device. */
		otherDevice: 'iPhone or iPad',
		/** Short enough to sit in a text-field placeholder. */
		deviceExample: 'iPhone',
	},
	windows: {
		id: 'windows',
		label: 'Windows',
		cloud: 'Google Drive',
		folderHint: 'Google Drive (usually G:) → My Drive → Obsidian',
		fileManager: 'File Explorer',
		otherDevice: 'other device',
		deviceExample: 'My laptop',
	},
	android: {
		id: 'android',
		label: 'Android',
		cloud: 'Google Drive',
		folderHint: 'Google Drive → Obsidian',
		fileManager: 'your files app',
		otherDevice: 'other device',
		deviceExample: 'My phone',
	},
	linux: {
		id: 'linux',
		label: 'Linux',
		cloud: 'Google Drive',
		folderHint: 'your Google Drive folder → Obsidian',
		fileManager: 'your file manager',
		otherDevice: 'other device',
		deviceExample: 'My laptop',
	},
	unknown: {
		id: 'unknown',
		label: 'this device',
		cloud: 'a sync folder',
		folderHint: 'a folder your sync client watches',
		fileManager: 'your file manager',
		otherDevice: 'other device',
		deviceExample: 'Other device',
	},
};

const DEFAULT_SETTINGS = {
	scanOnStartup: true,
	autoScanMinutes: 15,
	notifyOnConflicts: true,
	showStatusBar: true,
	/** Paths matching these prefixes never count toward the fingerprint. */
	excludePrefixes: [
		'.obsidian/workspace',
		'.trash/',
		'.git/',
		'.jemzsync/',
		SELF_DIR,
	],
	/** Filenames ignored everywhere. */
	excludeNames: ['.DS_Store'],
	/** Announce this device to the others by writing a small file in the vault. */
	writeBeacon: true,
	/** Rescan as soon as the vault changes, instead of waiting for the poll. */
	watchVault: true,
	/** Interrupt with a popup when the vault is somewhere that cannot sync. */
	warnOnBadLocation: true,
	/** Remembered so a second device can be compared without retyping. */
	pairedFingerprint: '',
	pairedDeviceLabel: '',
	/** Send changes to GitHub automatically, shortly after you stop typing. */
	githubAutoSync: true,
	/**
	 * How often to check GitHub for work done on another device.
	 *
	 * Two minutes rather than five: receiving is a poll because GitHub cannot
	 * notify a plugin, so the interval *is* the latency. Three requests per
	 * check against a 5,000/hour limit is under 2% of the budget, so there is
	 * no reason to make people wait longer than this.
	 */
	githubPullMinutes: 2,
};

/* ================================================================== *
 * CORE — pure functions, no Obsidian and no I/O. Everything in this
 * block is unit-tested by test/test-core.js.
 * ================================================================== */

/**
 * Turn Obsidian's platform flags into the one thing that decides where a vault
 * has to live. Order matters: the mobile flags are checked first because a
 * tablet can report a desktop-ish OS underneath.
 *
 * @param {{isIosApp?: boolean, isAndroidApp?: boolean, isMacOS?: boolean,
 *          isWin?: boolean, isLinux?: boolean}} flags
 * @returns {'apple'|'android'|'windows'|'linux'|'unknown'}
 */
function detectEcosystem(flags) {
	flags = flags || {};
	if (flags.isIosApp) return 'apple';
	if (flags.isAndroidApp) return 'android';
	if (flags.isMacOS) return 'apple';
	if (flags.isWin) return 'windows';
	if (flags.isLinux) return 'linux';
	return 'unknown';
}

/** Description of an ecosystem, falling back to a neutral one. */
function ecosystemInfo(id) {
	return ECOSYSTEMS[id] || ECOSYSTEMS.unknown;
}

/**
 * What is actually carrying this vault between devices.
 *
 * Normally that is the ecosystem's cloud, but once a vault is stored in a Git
 * repository the cloud is no longer the answer — and telling a cross-ecosystem
 * user to "give iCloud a few minutes" would be nonsense. Every message that
 * names the thing doing the syncing goes through here.
 *
 * @param {string} ecosystem
 * @param {string} [storageMode] 'ecosystem' (default) or 'github'
 */
function transportName(ecosystem, storageMode) {
	if (storageMode === 'github') return 'GitHub';
	return ecosystemInfo(ecosystem).cloud;
}

/*
 * Folders the desktop sync clients actually create. Google Drive alone has
 * three shapes depending on client version and OS, which is why this is a
 * table rather than one regex.
 */
const CLOUD_FOLDER_PATTERNS = [
	// iCloud first: on Windows it is a real sync folder, but one Obsidian warns
	// about, so it needs its own verdict rather than being lumped in with the
	// providers that are simply fine.
	{ id: 'icloud', label: 'iCloud Drive', re: /(^|\/)iCloud ?Drive(\/|$)/i },
	{ id: 'icloud', label: 'iCloud Drive', re: /(^|\/)Mobile Documents(\/|$)/i },
	{ id: 'icloud', label: 'iCloud Drive', re: /(^|\/)iCloud~[^/]*(\/|$)/i },
	{ id: 'gdrive', label: 'Google Drive', re: /(^|\/)My Drive(\/|$)/i },
	{ id: 'gdrive', label: 'Google Drive', re: /(^|\/)GoogleDrive-[^/]*(\/|$)/i },
	{ id: 'gdrive', label: 'Google Drive', re: /(^|\/)Google ?Drive(\/|$)/i },
	{ id: 'onedrive', label: 'OneDrive', re: /(^|\/)OneDrive([ -][^/]*)?(\/|$)/i },
	{ id: 'dropbox', label: 'Dropbox', re: /(^|\/)Dropbox(\/|$)/i },
];

/** Which sync client, if any, is watching this path. Null when nothing is. */
function detectCloudFolder(p) {
	const s = String(p || '');
	for (let i = 0; i < CLOUD_FOLDER_PATTERNS.length; i++) {
		if (CLOUD_FOLDER_PATTERNS[i].re.test(s)) {
			return {
				id: CLOUD_FOLDER_PATTERNS[i].id,
				label: CLOUD_FOLDER_PATTERNS[i].label,
			};
		}
	}
	return null;
}

/**
 * Work out where a vault lives and whether it can reach this device's siblings.
 *
 * Apple gets its own routine because iOS reads exactly one private container;
 * every other ecosystem only needs the vault to sit inside a watched folder.
 *
 * @param {string|null} basePath absolute vault path, or null when unavailable
 * @param {{platform?: string, vaultName?: string, ecosystem?: string}} ctx
 * @returns {{code: string, ok: boolean, syncing: boolean, title: string,
 *            detail: string, fixes: string[]}}
 */
function classifyVaultLocation(basePath, ctx) {
	ctx = ctx || {};
	const ecosystem = ctx.ecosystem || 'apple';

	/*
	 * When the repository is the storage, a vault sitting in an ordinary
	 * folder is correct — not broken. Telling someone in this mode to move
	 * their vault into iCloud would be the same mistake as the two already
	 * fixed in 1.2.1 and 1.3.0: advising a working setup to move itself.
	 *
	 * `both` deliberately does not take this branch. There the cloud really
	 * is expected to carry the vault as well, so the ordinary checks stand.
	 */
	if (ctx.storageMode === STORAGE_GITHUB) {
		return {
			code: 'github-primary',
			ok: true,
			syncing: true,
			title: 'Vault is stored in GitHub',
			detail:
				'This vault syncs through your GitHub repository, so it does not need to sit in ' +
				ecosystemInfo(ecosystem).cloud +
				'. It can live anywhere on this device.',
			fixes: [],
		};
	}

	if (ecosystem !== 'apple') {
		return classifyDriveLocation(basePath, ctx, ecosystem);
	}
	return classifyAppleLocation(basePath, ctx);
}

/**
 * Non-Apple ecosystems: the vault only has to be inside a folder some sync
 * client is watching. Google Drive is the recommendation, but OneDrive and
 * Dropbox work just as well and are not worth nagging about.
 */
function classifyDriveLocation(basePath, ctx, ecosystem) {
	const eco = ecosystemInfo(ecosystem);
	const vaultName = ctx.vaultName || 'YourVault';

	if (!basePath) {
		return {
			code: 'mobile-unverifiable',
			ok: false,
			syncing: false,
			title: 'Check the vault location yourself',
			detail:
				'Obsidian on ' +
				eco.label +
				' does not expose the vault path, so jemzsync cannot read it. Confirm it by hand, then use the fingerprint below to check the two devices match.',
			fixes: [
				'Open your files app and find the folder holding "' + vaultName + '".',
				'It has to sit inside the folder your sync app keeps up to date.',
				'A vault in ordinary internal storage never leaves this device.',
			],
		};
	}

	const p = String(basePath).replace(/\\/g, '/').replace(/\/+$/, '');
	const cloud = detectCloudFolder(p);

	// Android reports a sandbox path that names no sync client either way, so an
	// unrecognised path there is unknown rather than local. Desktop paths are
	// trustworthy, so they still fall through to the local-only verdict below.
	if (!cloud && ctx.platform === 'mobile') {
		return {
			code: 'mobile-unverifiable',
			ok: false,
			syncing: false,
			title: 'Check the vault location yourself',
			detail:
				'Obsidian on ' +
				eco.label +
				' does not report a path jemzsync can judge. Confirm by hand that the vault is inside the folder your sync app watches, then compare fingerprints below.',
			fixes: [
				'Open your files app and find the folder holding "' + vaultName + '".',
				'It has to sit inside the folder your sync app keeps up to date.',
				'A vault in ordinary internal storage never leaves this device.',
			],
		};
	}

	// iCloud does replicate this folder, so calling it "not syncing" would be a
	// lie. But Obsidian's own documentation warns that iCloud Drive on Windows
	// can duplicate or corrupt files, so calling it "fine" would be worse.
	if (cloud && cloud.id === 'icloud') {
		return {
			code: 'icloud-outside-apple',
			ok: false,
			syncing: true,
			title: 'Vault is on iCloud Drive, which is risky on ' + eco.label,
			detail:
				'iCloud is replicating this folder, so your notes do travel. Obsidian documents that iCloud Drive on Windows can duplicate or corrupt files, and no plugin can prevent that — jemzsync can only tell you when it has happened.',
			fixes: [
				'Safest: keep iCloud for your Apple devices and move this vault into ' +
					eco.folderHint +
					', then open the Drive copy from every non-Apple device.',
				'Or use Obsidian Sync, which supports every platform directly.',
				'If you stay on iCloud here, scan often — the conflicts card lists the duplicate copies it leaves behind.',
			],
		};
	}

	if (cloud && cloud.id === 'gdrive') {
		return {
			code: 'ok',
			ok: true,
			syncing: true,
			title: 'Vault is in the right place',
			detail:
				'This vault lives in your Google Drive folder, so every device signed in to the same Google Account can reach it.',
			fixes: [],
		};
	}

	if (cloud) {
		return {
			code: 'alternate-cloud',
			ok: true,
			syncing: true,
			title: 'Vault is syncing through ' + cloud.label,
			detail:
				'That works. ' +
				cloud.label +
				' keeps this folder up to date the same way Google Drive would, so there is nothing to fix.',
			fixes: [],
		};
	}

	return {
		code: 'local-only',
		ok: false,
		syncing: false,
		title: 'Vault is stored locally and is not syncing',
		detail:
			'Nothing is replicating this folder, so changes stay on this device.',
		fixes: [
			'Install ' + eco.cloud + ' for desktop if you have not already.',
			'Move the vault into ' + eco.folderHint + '.',
			'Reopen it with "Open folder as vault" from the new location.',
		],
	};
}

/**
 * What we can honestly say on a device that will not tell us where the vault is.
 *
 * iOS and iPadOS hand back either nothing or a sandbox path with none of the
 * markers a Mac path carries. Both cases mean "unknown", and unknown must not
 * be reported as "local" — see the fallback at the end of classifyAppleLocation.
 */
function appleMobileUnverifiable(vaultName) {
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

function classifyAppleLocation(basePath, ctx) {
	ctx = ctx || {};
	const platform = ctx.platform || 'unknown';
	const vaultName = ctx.vaultName || 'YourVault';

	if (!basePath) {
		if (platform === 'mobile') {
			return appleMobileUnverifiable(vaultName);
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

	// Everything above keys off markers that only appear in a Mac path. On iOS
	// and iPadOS the adapter reports a sandbox path with none of them, so
	// falling through here means "we could not tell", not "it is local". Saying
	// local would tell someone whose iCloud vault is working perfectly to go and
	// move it — the one piece of advice guaranteed to make things worse.
	if (platform === 'mobile') {
		return appleMobileUnverifiable(vaultName);
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
 * Commands that move a vault into the folder this ecosystem's devices can see.
 * A backup always runs first and the original is never deleted.
 *
 * @param {string|null} basePath
 * @param {string} vaultName
 * @param {string} [ecosystem] defaults to Apple
 */
function buildMigrationPlan(basePath, vaultName, ecosystem) {
	if (ecosystem && ecosystem !== 'apple') {
		return buildDriveMigrationPlan(basePath, vaultName, ecosystem);
	}
	return buildAppleMigrationPlan(basePath, vaultName);
}

/**
 * Google Drive ecosystems. Windows gets real PowerShell; Android gets prose,
 * because there is no shell to paste into and — the part people trip over —
 * the Google Drive app does not expose a folder Obsidian can write to. On
 * Android the vault has to live in ordinary storage with a folder-sync app
 * pointed at it.
 */
function buildDriveMigrationPlan(basePath, vaultName, ecosystem) {
	const eco = ecosystemInfo(ecosystem);
	const name = vaultName || 'MyVault';
	const src = String(basePath || 'C:\\path\\to\\vault').replace(/[\\/]+$/, '');

	if (ecosystem === 'android') {
		return {
			container: 'Google Drive',
			target: 'Google Drive/' + name,
			shell: '',
			steps: [
				'On your Windows or Mac machine, put the vault inside the Google Drive folder first.',
				'On Android, Google Drive alone will not do — its app does not give Obsidian a folder it can write to.',
				'Install a folder-sync app (FolderSync or Autosync for Google Drive) and point it at Drive → ' +
					name +
					'.',
				'Open that local folder in Obsidian with "Open folder as vault".',
				'If you would rather not run a second app, Obsidian Sync handles Android directly.',
			],
		};
	}

	if (ecosystem === 'windows') {
		const target = '$env:USERPROFILE\\My Drive\\' + name;
		const lines = [
			'# 1. Back up first. Never skip this.',
			'Copy-Item -Recurse "' +
				src +
				'" "$env:USERPROFILE\\Desktop\\' +
				name +
				'-backup"',
			'',
			'# 2. Copy the vault into your Google Drive folder.',
			'#    Adjust the path if Drive is mounted on a letter such as G:.',
			'Copy-Item -Recurse "' + src + '" "' + target + '"',
		];
		return {
			container: '$env:USERPROFILE\\My Drive',
			target: target,
			shell: lines.join('\n'),
			steps: [
				'Run the commands below in PowerShell.',
				'In Obsidian, choose "Open folder as vault" and pick ' + eco.folderHint + '.',
				'Wait for Drive to finish uploading before editing on a second device.',
				'Compare fingerprints in the jemzsync panel once the other device has synced.',
			],
		};
	}

	return {
		container: eco.cloud,
		target: eco.cloud + '/' + name,
		shell: 'cp -R "' + src + '" "$HOME/' + eco.cloud.replace(/\s+/g, '') + '/' + name + '"',
		steps: [
			'Copy the vault into the folder your sync client watches.',
			'Reopen it there with "Open folder as vault".',
		],
	};
}

function buildAppleMigrationPlan(basePath, vaultName) {
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

/**
 * Should the setup popup interrupt the user?
 *
 * Only when there is something they can actually act on. A mobile vault whose
 * path we cannot read is not a fault — nagging about it every launch would
 * train people to dismiss the one warning that matters.
 *
 * `dismissedCode` is keyed by the specific problem, so moving a vault from
 * "local-only" into the wrong iCloud folder warns again rather than staying
 * silent on a stale dismissal.
 */
function shouldWarnAboutLocation(location, dismissedCode) {
	if (!location || location.ok) return false;
	if (location.code === 'mobile-unverifiable') return false;
	return dismissedCode !== location.code;
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
		/*
		 * Unconditional, not merely a default exclusion. Settings are saved
		 * into the vault, so anyone upgrading from a version that predates
		 * this carries the old exclusion list with them — and would go on
		 * seeing a false mismatch every time the plugin updated. Rejecting it
		 * here as well means the guard cannot be lost, which is exactly why
		 * the beacon guard is doubled up too.
		 */
		if (e.path.indexOf(SELF_DIR) === 0) continue;
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

/**
 * Human-readable comparison of two fingerprints.
 *
 * `transport` names whatever is moving the files. It is optional so that the
 * many existing callers keep working, and defaults to wording that is true on
 * every platform rather than to Apple's.
 */
function compareFingerprints(a, b, transport) {
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
	summary += ' Wait a few minutes for ' + (transport || 'your sync') + ', then scan again.';
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
function summarizeDevices(others, localFingerprint, now, staleMs, transport) {
	staleMs = staleMs || BEACON_STALE_MS;
	const out = [];
	for (let i = 0; i < others.length; i++) {
		const b = others[i];
		const cmp = compareFingerprints(localFingerprint, b.fingerprint, transport);
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

/* ---------------------- pairing auto-fill ---------------------- *
 *
 * The "other device" fields in settings predate beacons. They asked you to
 * copy a digest off one device and type it into another, which is exactly the
 * information a beacon already carries across on its own. These two functions
 * connect the one to the other.
 *
 * The rule throughout is that the plugin only ever helps into an empty field.
 * A value you typed is yours; nothing here may overwrite it.
 */

/**
 * Which of the other devices to pair with.
 *
 * Freshness wins over recency: a device that checked in an hour ago is a
 * better comparison than one that has been silent for a week, even if the
 * silent one somehow carries a newer timestamp.
 *
 * @param {Array} others beacons belonging to other devices
 * @param {number} now
 * @param {number} [staleMs]
 * @returns {object|null}
 */
function pickPairedBeacon(others, now, staleMs) {
	if (!others || !others.length) return null;
	staleMs = staleMs || BEACON_STALE_MS;

	let best = null;
	let bestFresh = false;

	for (let i = 0; i < others.length; i++) {
		const b = others[i];
		if (!b || !b.fingerprint || !b.fingerprint.digest) continue;

		/*
		 * Absolute distance, not elapsed time. Device clocks drift by seconds
		 * and that is harmless, but a beacon claiming to be from next month is
		 * not evidence of anything — and read as plain elapsed time it would
		 * come out *negative*, i.e. fresher than everything, and win.
		 */
		const fresh = Math.abs(now - (b.updatedAt || 0)) <= staleMs;
		if (!best) {
			best = b;
			bestFresh = fresh;
			continue;
		}
		if (fresh && !bestFresh) {
			best = b;
			bestFresh = true;
			continue;
		}
		if (fresh === bestFresh && (b.updatedAt || 0) > (best.updatedAt || 0)) {
			best = b;
			bestFresh = fresh;
		}
	}
	return best;
}

/**
 * Decide what a pairing field should hold, given what is in it now, where that
 * came from, and what the plugin has detected.
 *
 * `source` records provenance, and is the whole reason this is safe:
 *
 *   'manual'  you typed it — never touched, no matter what is detected
 *   'auto'    the plugin filled it — refreshed when detection moves on
 *   ''        empty, or carried over from a version before this existed
 *
 * An empty field is always fillable, including one you cleared yourself. That
 * is deliberate: clearing a field is how you ask for help again.
 *
 * @returns {{value: string, source: string, changed: boolean}}
 */
function autofillValue(current, source, detected) {
	const cur = String(current == null ? '' : current).trim();
	const det = String(detected == null ? '' : detected).trim();

	// Nothing detected: leave the field exactly as it is.
	if (!det) return { value: cur, source: source || '', changed: false };

	// A typed value outranks anything detected.
	if (source === 'manual' && cur) {
		return { value: cur, source: 'manual', changed: false };
	}

	// Empty — whether never filled, or cleared just now to invite a refill.
	if (!cur) return { value: det, source: 'auto', changed: cur !== det };

	if (source === 'auto') {
		return { value: det, source: 'auto', changed: cur !== det };
	}

	// Non-empty with no provenance: an upgrade from a version that had no
	// auto-fill, so the only thing it can be is something the user typed.
	// Claim it as manual so it is protected from here on.
	return { value: cur, source: 'manual', changed: true };
}

/* ---------------------- device naming ---------------------- */

/**
 * A sensible name for this device from Obsidian's platform flags alone.
 *
 * The mobile flags are checked before the desktop ones because `isPhone` and
 * `isTablet` are set on Android too — reading them first is what used to make
 * an Android phone introduce itself as "iPhone".
 *
 * No user-agent parsing: it is brittle, and the field is editable precisely
 * because a derived label can only ever be a starting point.
 */
function suggestDeviceName(flags) {
	flags = flags || {};
	if (flags.isIosApp) return flags.isTablet ? 'iPad' : 'iPhone';
	if (flags.isAndroidApp) return flags.isTablet ? 'Android tablet' : 'Android phone';
	if (flags.isMacOS && flags.isDesktopApp) return 'Mac';
	if (flags.isWin) return 'Windows PC';
	if (flags.isLinux) return 'Linux PC';
	if (flags.isDesktopApp) return 'Desktop';
	if (flags.isMobileApp) return 'Mobile';
	return 'Device';
}

/**
 * Devices that have checked in recently enough to still speak for themselves.
 *
 * Reinstalling Obsidian, or rebuilding a phone, gives a device a new id and
 * leaves its old beacon in the vault forever — nothing ever deletes one. Those
 * ghosts must not go on holding a claim to a name, or a phone that has been
 * set up twice ends up introducing itself as "iPhone 3".
 */
function freshBeacons(others, now, staleMs) {
	staleMs = staleMs || BEACON_STALE_MS;
	const out = [];
	for (let i = 0; i < (others || []).length; i++) {
		const b = others[i];
		if (!b) continue;
		if (Math.abs(now - (b.updatedAt || 0)) <= staleMs) out.push(b);
	}
	return out;
}

/**
 * Two Macs in one vault both called "Mac" are indistinguishable in the Devices
 * panel. Beacons already say who is here, so the second one can name itself
 * "Mac 2" without asking anyone.
 *
 * `selfId` is what stops both of them renaming at the same moment. Two fresh
 * Macs that have not yet seen each other are both "Mac"; when the beacons
 * finally arrive, an unqualified rule would move both to "Mac 2" and the
 * collision would simply follow them. So a name is only contested by a device
 * whose id sorts before ours — exactly one side gives way, and it converges.
 * Omit `selfId` and any collision contests, which is the simpler rule to
 * reason about when there is only one candidate.
 */
function disambiguateDeviceName(base, others, selfId) {
	const name = String(base || 'Device');
	const lower = name.toLowerCase();
	const taken = Object.create(null);
	let contested = false;

	for (let i = 0; i < (others || []).length; i++) {
		const o = others[i];
		if (!o || !o.name) continue;
		const otherName = String(o.name).toLowerCase();
		taken[otherName] = true;
		if (otherName !== lower) continue;
		if (!selfId || String(o.id || '') < String(selfId)) contested = true;
	}

	if (!contested) return name;
	for (let n = 2; n < 100; n++) {
		const candidate = name + ' ' + n;
		if (!taken[candidate.toLowerCase()]) return candidate;
	}
	return name;
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

/* ---------------------- live watching ---------------------- *
 *
 * Watching the vault is what makes the panel react in seconds rather than on
 * the next poll. It also introduces the one way this plugin could eat itself:
 * writing a beacon is a vault change, so an unfiltered watcher would scan,
 * write a beacon, see the write, scan again, forever — and the two devices
 * would keep waking each other up over the cloud. This is the guard.
 */

/**
 * Is this change worth a rescan?
 *
 * Beacons are rejected twice over: once by path prefix (they live under the
 * excluded `.jemzsync/`) and once by `isBeaconPath`. Either check alone would
 * do; keeping both means loosening one exclusion cannot silently reopen the
 * feedback loop.
 */
function shouldRescanForChange(path, settings) {
	settings = settings || DEFAULT_SETTINGS;
	const p = String(path || '');
	if (!p) return false;
	if (isBeaconPath(p)) return false;
	// Our own files, for the same reason and with the same belt-and-braces.
	if (p.indexOf(SELF_DIR) === 0) return false;

	const parts = splitPath(p);
	const names = settings.excludeNames || [];
	if (names.indexOf(parts.base) !== -1) return false;

	const prefixes = settings.excludePrefixes || [];
	for (let i = 0; i < prefixes.length; i++) {
		if (p.indexOf(prefixes[i]) === 0) return false;
	}
	return true;
}

/* ================================================================== *
 * GITHUB — pure logic
 *
 * Everything in this block is I/O-free and unit-tested. The transport
 * lives further down; keeping the decisions up here means the rules about
 * what gets uploaded, what never leaves the device, and what happens when
 * two devices disagree can all be tested without a network.
 * ================================================================== */

const GITHUB_API = 'https://api.github.com';

/**
 * Paths that must never be pushed to a repository.
 *
 * Deliberately separate from `excludePrefixes`, which decides what counts
 * toward the vault fingerprint. Conflating them would change what a
 * fingerprint means, and these two lists answer different questions:
 * "is this the same vault?" versus "is this safe to publish?".
 *
 * The first entry is the important one. Obsidian plugins keep their
 * configuration — including API keys and access tokens — in
 * `.obsidian/plugins/<id>/data.json`. Pushing the config folder wholesale
 * would commit other people's secrets to a Git repository, which is
 * exactly the sort of accident that is impossible to take back once the
 * commit exists.
 */
const REPO_ALWAYS_EXCLUDE = [
	{ re: /^\.obsidian\/plugins\/[^/]+\/data\.json$/, why: 'may contain another plugin\'s secrets' },
	/*
	 * jemzsync's own code. Two reasons, either sufficient:
	 *
	 * Obsidian's developer policy forbids a plugin installing or updating
	 * itself, and shipping its own main.js to every other device through the
	 * repository is exactly that.
	 *
	 * And it is the same self-reference trap as the fingerprint: updating the
	 * plugin changes main.js, so a device on the new version and one on the
	 * old disagree about a file neither user ever touched — which produced a
	 * "main (github conflicted copy).js" sitting in the repository.
	 */
	{ re: /^\.obsidian\/plugins\/jemzsync\//, why: 'the plugin does not sync itself' },
	{ re: /^\.obsidian\/workspace/, why: 'per-device pane layout' },
	{ re: /^\.jemzsync\//, why: 'device beacons are local coordination' },
	{ re: /^\.trash\//, why: 'deleted files' },
	{ re: /^\.git\//, why: 'git internals' },
	{ re: /(^|\/)\.DS_Store$/, why: 'macOS folder metadata' },
	{ re: /(^|\/)\..+\.icloud$/, why: 'an offloaded placeholder, not real content' },
];

/**
 * Largest file to upload.
 *
 * GitHub blocks anything over 100 MB outright and gets unreliable well
 * before that. Base64 also inflates a file by a third *and* holds both
 * copies in memory at once, which matters far more on a phone than on a
 * desktop. Skipping with a visible warning beats failing the whole sync.
 */
const REPO_MAX_FILE_BYTES = 40 * 1024 * 1024;

/** Git's own mode for an ordinary file. The only one a vault needs. */
const GIT_FILE_MODE = '100644';

/**
 * Should this path be pushed?
 *
 * @returns {{ok: boolean, why: string}} `why` is shown in the preview, so a
 *   skipped file is always accounted for rather than silently missing.
 */
function shouldPushPath(path, size, opts) {
	opts = opts || {};
	const p = String(path || '').replace(/^\/+/, '');
	if (!p) return { ok: false, why: 'empty path' };

	for (let i = 0; i < REPO_ALWAYS_EXCLUDE.length; i++) {
		if (REPO_ALWAYS_EXCLUDE[i].re.test(p)) {
			return { ok: false, why: REPO_ALWAYS_EXCLUDE[i].why };
		}
	}

	// Optional: some people want the notes and nothing else.
	if (opts.notesOnly && p.indexOf('.obsidian/') === 0) {
		return { ok: false, why: 'Obsidian configuration ("notes only" is on)' };
	}

	const extra = opts.excludePrefixes || [];
	for (let i = 0; i < extra.length; i++) {
		if (extra[i] && p.indexOf(extra[i]) === 0) {
			return { ok: false, why: 'excluded by your settings' };
		}
	}

	const max = opts.maxBytes || REPO_MAX_FILE_BYTES;
	if (size > max) {
		return { ok: false, why: 'larger than ' + formatBytes(max) };
	}

	return { ok: true, why: '' };
}

/**
 * Work out what has to change in the repository.
 *
 * Compares the vault against the tree already on the branch, by Git blob
 * SHA. That is an exact comparison rather than a guess: a file whose hash
 * matches the one in the tree is byte-for-byte identical and is not
 * uploaded, no matter what its timestamps say. This codebase already knows
 * modification times drift between devices for harmless reasons.
 *
 * @param {Array<{path: string, sha: string, size: number}>} local
 * @param {Object<string,string>} remote path → blob sha already in the repo
 * @returns {{create: Array, update: Array, remove: Array, unchanged: number}}
 */
function buildPushPlan(local, remote) {
	remote = remote || {};
	const plan = { create: [], update: [], remove: [], unchanged: 0 };
	const seen = Object.create(null);

	for (let i = 0; i < (local || []).length; i++) {
		const f = local[i];
		seen[f.path] = true;
		const at = remote[f.path];
		if (!at) plan.create.push(f);
		else if (at !== f.sha) plan.update.push(f);
		else plan.unchanged++;
	}

	const paths = Object.keys(remote).sort();
	for (let i = 0; i < paths.length; i++) {
		if (!seen[paths[i]]) plan.remove.push({ path: paths[i], sha: remote[paths[i]] });
	}

	plan.create.sort(function (a, b) {
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});
	plan.update.sort(function (a, b) {
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});
	return plan;
}

/** Does this plan change anything at all? */
function planIsEmpty(plan) {
	return (
		!plan ||
		(plan.create.length === 0 && plan.update.length === 0 && plan.remove.length === 0)
	);
}

/**
 * Does applying this plan destroy anything the user might want back?
 *
 * Adding files is safe and applies without interruption. Deleting or
 * overwriting is not, and is what the confirmation step exists for.
 */
function planIsDestructive(plan) {
	return !!plan && (plan.remove.length > 0 || plan.update.length > 0);
}

/** One line describing what a push will do. */
function describePlan(plan) {
	if (planIsEmpty(plan)) return 'Everything is already up to date.';
	const bits = [];
	if (plan.create.length) bits.push(plan.create.length + ' added');
	if (plan.update.length) bits.push(plan.update.length + ' changed');
	if (plan.remove.length) bits.push(plan.remove.length + ' removed');
	return bits.join(', ');
}

/**
 * The tree entries for a commit.
 *
 * A removal is expressed by handing GitHub the path with a null sha, which
 * is how the Git Data API spells "this is gone" against a base tree.
 */
function buildTreeEntries(plan, shaFor) {
	const out = [];
	const changed = plan.create.concat(plan.update);
	for (let i = 0; i < changed.length; i++) {
		out.push({
			path: changed[i].path,
			mode: GIT_FILE_MODE,
			type: 'blob',
			sha: shaFor[changed[i].path],
		});
	}
	for (let i = 0; i < plan.remove.length; i++) {
		out.push({
			path: plan.remove[i].path,
			mode: GIT_FILE_MODE,
			type: 'blob',
			sha: null,
		});
	}
	return out;
}

/* ---------------------- two-way sync ---------------------- *
 *
 * Once the repository is carrying the vault between devices, "what changed"
 * stops being a question with one answer. Both sides can have moved since
 * they last agreed, and the only way to tell an edit from a deletion is to
 * remember what they last agreed *on*.
 *
 * That remembered state is the base. Without it:
 *   a file present remotely and absent locally is indistinguishable from
 *   "they added it" versus "I deleted it" — and guessing wrong either
 *   resurrects a note you deleted or deletes one they wrote.
 */

/**
 * Name for a note pulled down that would have overwritten a local edit.
 *
 * Deliberately matches the "conflicted copy" shape that `CONFLICT_PATTERNS`
 * already recognises, so the existing Keep newest / Merge both buttons pick
 * it up with no new conflict-resolution code at all.
 */
function conflictCopyName(path, when) {
	const parts = splitPath(path);
	const stamp = String(when || '').slice(0, 10) || 'sync';
	return joinPath(parts.dir, parts.stem + ' (github conflicted copy ' + stamp + ')' + parts.ext);
}

/**
 * Decide what happens to every path, given three views of it.
 *
 * @param {Object<string,string>} base   path → blob sha at the last agreement
 * @param {Object<string,string>} local  path → blob sha in the vault now
 * @param {Object<string,string>} remote path → blob sha on the branch now
 */
function buildSyncPlan(base, local, remote) {
	base = base || {};
	local = local || {};
	remote = remote || {};

	const plan = {
		pull: [], // write these into the vault
		push: [], // send these to the repository
		deleteLocal: [], // remotely deleted, and untouched here
		deleteRemote: [], // deleted here, and untouched there
		conflict: [], // both sides moved
		unchanged: 0,
	};

	const paths = Object.create(null);
	[base, local, remote].forEach(function (m) {
		Object.keys(m).forEach(function (p) {
			paths[p] = true;
		});
	});

	Object.keys(paths)
		.sort()
		.forEach(function (path) {
			const B = base[path];
			const L = local[path];
			const R = remote[path];

			// Already agree. Nothing to do, whether both hold it or neither.
			if (L === R) {
				if (L) plan.unchanged++;
				return;
			}

			const localMoved = B !== L;
			const remoteMoved = B !== R;

			if (!localMoved && remoteMoved) {
				if (R) plan.pull.push({ path: path, sha: R });
				else plan.deleteLocal.push({ path: path });
				return;
			}

			if (localMoved && !remoteMoved) {
				if (L) plan.push.push({ path: path, sha: L });
				else plan.deleteRemote.push({ path: path });
				return;
			}

			/*
			 * Both sides moved. Where both still hold the file this is a real
			 * conflict and both versions are kept.
			 *
			 * Where one side deleted and the other edited, the edit wins. A
			 * deletion carries no information that an edit does not already
			 * override, and resurrecting a file is recoverable while losing
			 * someone's writing is not.
			 */
			if (L && R) {
				plan.conflict.push({ path: path, localSha: L, remoteSha: R });
			} else if (L && !R) {
				plan.push.push({ path: path, sha: L, note: 'kept: edited here, deleted there' });
			} else if (R && !L) {
				plan.pull.push({ path: path, sha: R, note: 'kept: edited there, deleted here' });
			}
		});

	return plan;
}

/** Does this sync plan do anything? */
function syncPlanIsEmpty(plan) {
	return (
		!plan ||
		(plan.pull.length === 0 &&
			plan.push.length === 0 &&
			plan.deleteLocal.length === 0 &&
			plan.deleteRemote.length === 0 &&
			plan.conflict.length === 0)
	);
}

/** Would applying this plan remove or overwrite anything held locally? */
function syncPlanIsDestructive(plan) {
	return !!plan && (plan.deleteLocal.length > 0 || plan.pull.length > 0);
}

/** One line for a notice or the panel. */
function describeSyncPlan(plan) {
	if (syncPlanIsEmpty(plan)) return 'Everything is in sync.';
	const bits = [];
	if (plan.push.length) bits.push(plan.push.length + ' sent');
	if (plan.pull.length) bits.push(plan.pull.length + ' received');
	if (plan.deleteRemote.length) bits.push(plan.deleteRemote.length + ' removed remotely');
	if (plan.deleteLocal.length) bits.push(plan.deleteLocal.length + ' removed here');
	if (plan.conflict.length) bits.push(plan.conflict.length + ' conflicted');
	return bits.join(', ');
}

/** `owner/name`, tolerating a full URL or a trailing `.git`. */
function parseRepoRef(text) {
	const s = String(text || '')
		.trim()
		.replace(/^https?:\/\/(www\.)?github\.com\//i, '')
		.replace(/\.git$/i, '')
		.replace(/^\/+|\/+$/g, '');
	const m = s.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
	if (!m) return null;
	return { owner: m[1], name: m[2], full: m[1] + '/' + m[2] };
}

/** Follow `Link: <...>; rel="next"` so a long repo list is not truncated. */
function parseNextLink(linkHeader) {
	const s = String(linkHeader || '');
	const parts = s.split(',');
	for (let i = 0; i < parts.length; i++) {
		const m = parts[i].match(/<([^>]+)>\s*;\s*rel="next"/);
		if (m) return m[1];
	}
	return null;
}

/**
 * Turn an HTTP failure into something worth reading.
 *
 * A bare "403" tells nobody anything. Each of these is a different problem
 * with a different fix, and guessing wrong wastes real time.
 */
function classifyGithubError(status, body, path) {
	const msg = (body && body.message) || '';
	if (status === 401) {
		return {
			fatal: true,
			message: 'GitHub rejected the token. It may have been revoked or expired — reconnect to fix it.',
		};
	}
	if (status === 403 && /rate limit/i.test(msg)) {
		return { fatal: false, message: 'GitHub rate limit reached. Waiting before trying again.' };
	}
	if (status === 403) {
		return {
			fatal: true,
			message:
				'The token does not have permission for this repository. It needs Contents: read and write.',
		};
	}
	if (status === 404) {
		return {
			fatal: true,
			message:
				'Not found: ' +
				(path || 'the repository') +
				'. For a private repository this usually means the token was not granted access to it.',
		};
	}
	if (status === 409) {
		return { fatal: true, message: 'The repository is empty. Add a first commit, or let jemzsync create one.' };
	}
	if (status === 422) {
		return {
			fatal: false,
			message:
				'Another device pushed first, so this push was refused rather than overwriting it. Sync again to merge.',
		};
	}
	if (status >= 500) {
		return { fatal: false, message: 'GitHub is having trouble (' + status + '). Trying again shortly.' };
	}
	return { fatal: true, message: 'GitHub returned ' + status + (msg ? ': ' + msg : '') };
}

/**
 * How long to wait before retrying.
 *
 * Honours GitHub's own `Retry-After` and the reset timestamp when it sends
 * them, because guessing shorter than they asked for is how an account
 * gets throttled harder.
 */
function githubBackoffMs(status, headers, attempt) {
	headers = headers || {};
	const retryAfter = Number(headers['retry-after'] || headers['Retry-After']);
	if (retryAfter > 0) return Math.min(retryAfter * 1000, 60000);

	const remaining = Number(headers['x-ratelimit-remaining']);
	const reset = Number(headers['x-ratelimit-reset']);
	if (status === 403 && remaining === 0 && reset > 0) {
		const waitMs = reset * 1000 - Date.now();
		if (waitMs > 0) return Math.min(waitMs + 1000, 60000);
	}

	const n = Math.max(0, Number(attempt) || 0);
	return Math.min(1000 * Math.pow(2, n), 30000);
}

/**
 * Is another attempt worth making?
 *
 * 409 is here because of a race seen on a real, freshly created repository:
 * the first commit is written through the Contents API and succeeds, but for
 * a moment afterwards GitHub still answers "Git Repository is empty" to the
 * Git Data endpoints. Retrying rides that out. A genuinely empty repository
 * never reaches here — reading the ref resolves that case first.
 */
function githubShouldRetry(status, attempt, maxAttempts) {
	if (attempt >= (maxAttempts || 4)) return false;
	return status === 403 || status === 409 || status === 429 || status >= 500;
}

/* ---------------------- bytes and hashes ---------------------- */

/**
 * Base64, without Node's Buffer.
 *
 * Buffer does not exist on iOS or Android, and using it would quietly make
 * the plugin desktop-only — the one property this whole file is arranged
 * to protect. `btoa` is present in both Obsidian's webview and in Node.
 * Chunked because `String.fromCharCode.apply` blows the argument limit on
 * anything larger than a small file.
 */
function bytesToBase64(bytes) {
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

function base64ToBytes(b64) {
	const binary = atob(String(b64 || '').replace(/\s+/g, ''));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/**
 * A file's Git blob SHA: sha1("blob " + length + "\0" + contents).
 *
 * Computing the same hash Git computes is what makes the diff exact. The
 * repository already tells us the blob sha of every file it holds, so a
 * local file whose hash matches is provably identical and can be skipped —
 * no timestamps, no size heuristics, no re-uploading a 40 MB attachment
 * because iCloud restamped it.
 */
async function gitBlobSha(bytes) {
	const header = new TextEncoder().encode('blob ' + bytes.length + '\0');
	const buf = new Uint8Array(header.length + bytes.length);
	buf.set(header, 0);
	buf.set(bytes, header.length);
	const digest = await crypto.subtle.digest('SHA-1', buf);
	const view = new Uint8Array(digest);
	let hex = '';
	for (let i = 0; i < view.length; i++) {
		hex += view[i].toString(16).padStart(2, '0');
	}
	return hex;
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
	pickPairedBeacon: pickPairedBeacon,
	autofillValue: autofillValue,
	freshBeacons: freshBeacons,
	suggestDeviceName: suggestDeviceName,
	disambiguateDeviceName: disambiguateDeviceName,
	detectEcosystem: detectEcosystem,
	ecosystemInfo: ecosystemInfo,
	transportName: transportName,
	detectCloudFolder: detectCloudFolder,
	shouldWarnAboutLocation: shouldWarnAboutLocation,
	shouldRescanForChange: shouldRescanForChange,
	ECOSYSTEMS: ECOSYSTEMS,
	LIVE_SCAN_DEBOUNCE_MS: LIVE_SCAN_DEBOUNCE_MS,
	BEACON_DIR: BEACON_DIR,
	BEACON_MIN_INTERVAL_MS: BEACON_MIN_INTERVAL_MS,
	BEACON_STALE_MS: BEACON_STALE_MS,
	CONFLICT_PATTERNS: CONFLICT_PATTERNS,
	DEFAULT_SETTINGS: DEFAULT_SETTINGS,
	SELF_DIR: SELF_DIR,

	/* GitHub, pure half */
	shouldPushPath: shouldPushPath,
	buildPushPlan: buildPushPlan,
	planIsEmpty: planIsEmpty,
	planIsDestructive: planIsDestructive,
	describePlan: describePlan,
	buildTreeEntries: buildTreeEntries,
	buildSyncPlan: buildSyncPlan,
	syncPlanIsEmpty: syncPlanIsEmpty,
	syncPlanIsDestructive: syncPlanIsDestructive,
	describeSyncPlan: describeSyncPlan,
	conflictCopyName: conflictCopyName,
	parseRepoRef: parseRepoRef,
	parseNextLink: parseNextLink,
	classifyGithubError: classifyGithubError,
	githubBackoffMs: githubBackoffMs,
	githubShouldRetry: githubShouldRetry,
	bytesToBase64: bytesToBase64,
	base64ToBytes: base64ToBytes,
	gitBlobSha: gitBlobSha,
	REPO_ALWAYS_EXCLUDE: REPO_ALWAYS_EXCLUDE,
	REPO_MAX_FILE_BYTES: REPO_MAX_FILE_BYTES,
	GITHUB_API: GITHUB_API,
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
 * GITHUB — transport and API
 *
 * One request helper, and the handful of endpoints a vault needs. The
 * transport is injected rather than imported so the whole client can be
 * driven by a fake in the tests, the same way the scanner is driven by a
 * fake adapter.
 * ================================================================== */

/**
 * A GitHub client.
 *
 * @param {string} token
 * @param {function} request  ({url, method, headers, body}) → {status, headers, text}
 * @param {function} [sleep]  injected so tests do not actually wait
 */
function githubClient(token, request, sleep) {
	const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

	/**
	 * One API call, with retries for the failures that are worth retrying.
	 *
	 * Deliberately reads `status` and parses `text` itself rather than
	 * relying on `throw: false` or the `json` accessor: an error status is
	 * information here, not an exception, and the response body carries the
	 * message that makes it diagnosable.
	 */
	async function call(method, path, body, opts) {
		opts = opts || {};
		const url = path.indexOf('http') === 0 ? path : GITHUB_API + path;
		let attempt = 0;

		for (;;) {
			let res;
			try {
				res = await request({
					url: url,
					method: method,
					headers: {
						Authorization: 'Bearer ' + token,
						Accept: 'application/vnd.github+json',
						'X-GitHub-Api-Version': '2022-11-28',
						'User-Agent': 'jemzsync',
						'Content-Type': 'application/json',
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					throw: false,
				});
			} catch (err) {
				// A dropped connection is not an answer; treat it as retryable.
				if (attempt >= 3) throw new Error('Could not reach GitHub: ' + (err && err.message));
				await wait(githubBackoffMs(0, {}, attempt));
				attempt++;
				continue;
			}

			const text = res.text || '';
			let json = null;
			if (text) {
				try {
					json = JSON.parse(text);
				} catch (_) {
					/* an HTML error page, or an empty 204 — json stays null */
				}
			}

			if (res.status >= 200 && res.status < 300) {
				return { status: res.status, json: json, headers: res.headers || {} };
			}

			/*
			 * "Does this branch exist yet?" has two negative answers, not one.
			 * A repository that exists but has never been committed to answers
			 * 409 "Git Repository is empty" rather than 404 — and treating that
			 * as a hard error is what stopped a brand-new repository from ever
			 * receiving its first sync.
			 */
			if ((res.status === 404 || res.status === 409) && opts.allowMissing) {
				return { status: res.status, json: null, headers: res.headers || {}, missing: true };
			}

			if (githubShouldRetry(res.status, attempt, 4)) {
				await wait(githubBackoffMs(res.status, res.headers || {}, attempt));
				attempt++;
				continue;
			}

			const info = classifyGithubError(res.status, json, path);
			const err = new Error(info.message);
			err.status = res.status;
			err.fatal = info.fatal;
			throw err;
		}
	}

	/** Walk `Link: rel="next"` so a long list is never silently truncated. */
	async function paged(path, limit) {
		const out = [];
		let next = path;
		while (next && out.length < (limit || 1000)) {
			const r = await call('GET', next);
			if (!Array.isArray(r.json)) break;
			for (let i = 0; i < r.json.length; i++) out.push(r.json[i]);
			next = parseNextLink(r.headers.link || r.headers.Link);
		}
		return out;
	}

	return {
		call: call,

		/** Who the token belongs to — also proves the token works at all. */
		async whoami() {
			const r = await call('GET', '/user');
			return { login: r.json.login, name: r.json.name };
		},

		/** Repositories the user owns, private ones included. */
		async listRepos() {
			const raw = await paged('/user/repos?affiliation=owner&sort=updated&per_page=100', 300);
			return raw.map((r) => ({
				full: r.full_name,
				name: r.name,
				owner: r.owner && r.owner.login,
				private: !!r.private,
				defaultBranch: r.default_branch || 'main',
			}));
		},

		async createRepo(name, isPrivate) {
			const r = await call('POST', '/user/repos', {
				name: name,
				private: isPrivate !== false,
				auto_init: true,
				description: 'Obsidian vault, synced by jemzsync',
			});
			return { full: r.json.full_name, defaultBranch: r.json.default_branch || 'main' };
		},

		/** Head commit of a branch, or null when the branch does not exist. */
		async getRef(repo, branch) {
			const r = await call(
				'GET',
				'/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(branch),
				undefined,
				{ allowMissing: true }
			);
			if (r.missing) return null;
			return r.json.object.sha;
		},

		async getCommit(repo, sha) {
			const r = await call('GET', '/repos/' + repo + '/git/commits/' + sha);
			return { sha: r.json.sha, tree: r.json.tree.sha };
		},

		/**
		 * Every file on the branch, as path → blob sha.
		 *
		 * GitHub caps a recursive tree at 100,000 entries and 7 MB, and sets
		 * `truncated` when it hits that. A truncated tree looks exactly like a
		 * repository missing files, so pushing against one would delete
		 * everything it failed to mention. It is refused instead.
		 */
		async readTree(repo, treeSha) {
			const r = await call(
				'GET',
				'/repos/' + repo + '/git/trees/' + treeSha + '?recursive=1'
			);
			if (r.json.truncated) {
				throw new Error(
					'This repository is too large for jemzsync to read in one request, so it cannot safely work out what changed. Syncing has stopped rather than risk removing files.'
				);
			}
			const map = Object.create(null);
			const tree = r.json.tree || [];
			for (let i = 0; i < tree.length; i++) {
				if (tree[i].type === 'blob') map[tree[i].path] = tree[i].sha;
			}
			return map;
		},

		/**
		 * Put the very first commit on a branch.
		 *
		 * A repository with no commits at all rejects the entire Git Data
		 * API — `POST /git/blobs` itself answers 409 "Git Repository is
		 * empty", so there is no way to build up a tree and commit the usual
		 * way. The Contents API is the one endpoint that works in that state,
		 * so it is used exactly once, to create a root commit out of a single
		 * real file. Everything after that goes the efficient route.
		 *
		 * A freshly created repository is the normal case here, so this is a
		 * first-run path rather than an edge case.
		 */
		async bootstrapBranch(repo, branch, filePath, base64, message) {
			const encoded = String(filePath)
				.split('/')
				.map(encodeURIComponent)
				.join('/');
			const r = await call('PUT', '/repos/' + repo + '/contents/' + encoded, {
				message: message || 'jemzsync: first commit',
				content: base64,
				branch: branch,
			});
			return r.json.commit.sha;
		},

		/** A file's contents, as bytes. */
		async readBlob(repo, sha) {
			const r = await call('GET', '/repos/' + repo + '/git/blobs/' + sha);
			return base64ToBytes(r.json.content || '');
		},

		async createBlob(repo, base64) {
			const r = await call('POST', '/repos/' + repo + '/git/blobs', {
				content: base64,
				encoding: 'base64',
			});
			return r.json.sha;
		},

		async createTree(repo, entries, baseTree) {
			const body = { tree: entries };
			if (baseTree) body.base_tree = baseTree;
			const r = await call('POST', '/repos/' + repo + '/git/trees', body);
			return r.json.sha;
		},

		async createCommit(repo, message, treeSha, parents) {
			const r = await call('POST', '/repos/' + repo + '/git/commits', {
				message: message,
				tree: treeSha,
				parents: parents || [],
			});
			return r.json.sha;
		},

		/**
		 * Move the branch to a new commit.
		 *
		 * `force` is deliberately absent. If another device pushed in the
		 * meantime this is not a fast-forward and GitHub refuses with 422 —
		 * which is the correct outcome. Forcing here would silently erase
		 * whatever the other device had just written.
		 */
		async updateRef(repo, branch, sha) {
			await call('PATCH', '/repos/' + repo + '/git/refs/heads/' + encodeURIComponent(branch), {
				sha: sha,
			});
		},

		async createRef(repo, branch, sha) {
			await call('POST', '/repos/' + repo + '/git/refs', {
				ref: 'refs/heads/' + branch,
				sha: sha,
			});
		},
	};
}

/**
 * Read the vault and work out what the repository is missing.
 *
 * Hashes every eligible file the way Git would, so the comparison against
 * the repository's own tree is exact rather than a guess.
 *
 * @param {function} listFiles  () → [{path, size}]
 * @param {function} readBytes  (path) → Uint8Array
 * @param {object} opts  {notesOnly, excludePrefixes, maxBytes}
 */
async function collectPushable(listFiles, readBytes, opts) {
	const files = [];
	const skipped = [];
	const errors = [];
	const entries = await listFiles();

	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const verdict = shouldPushPath(e.path, e.size, opts);
		if (!verdict.ok) {
			skipped.push({ path: e.path, why: verdict.why });
			continue;
		}
		try {
			const bytes = await readBytes(e.path);
			files.push({ path: e.path, size: bytes.length, sha: await gitBlobSha(bytes) });
		} catch (err) {
			// A file we cannot read must not be treated as deleted, or the push
			// would remove it from the repository. Recorded and left alone.
			errors.push({ path: e.path, message: String((err && err.message) || err) });
		}
	}

	files.sort(function (a, b) {
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});
	return { files: files, skipped: skipped, errors: errors };
}

/**
 * Refuse to sync from a partial view of the vault.
 *
 * The scanner stops after a hard cap, and every file past it would be absent
 * from the local list — which reads as "deleted" and removes them from the
 * repository. A partial view is never safe to act on.
 */
function assertScanComplete(scan) {
	if (scan && scan.truncated) {
		throw new Error(
			'This vault has more files than jemzsync can scan in one pass, so it cannot tell what changed. Syncing has stopped rather than risk removing files.'
		);
	}
}

/**
 * Files that exist but cannot be read at this moment.
 *
 * iCloud replaces a file's contents with a `.icloud` stub whenever it wants
 * disk space back, and the scanner reports those separately — so they never
 * reach the upload list. Left at that, the sync concludes they were deleted
 * and removes them from the repository. On an Apple vault that is routine.
 *
 * They are reported the same way an unreadable file is, which the sync engine
 * already knows to leave untouched on both sides.
 */
function unreadableFromScan(scan) {
	const out = [];
	const list = (scan && scan.placeholders) || [];
	for (let i = 0; i < list.length; i++) {
		out.push({ path: list[i].expects, message: 'not downloaded from the cloud yet' });
	}
	return out;
}

/**
 * Remove a file in a way that can be undone.
 *
 * Never a plain delete. Obsidian's file index lags behind the disk for a note
 * created moments ago, so the lookup can return nothing for a file that
 * certainly exists — and falling back to `remove` made a sync-triggered
 * deletion permanently unrecoverable. That happened on a real vault. Anything
 * the index does not know about is moved into the vault's own trash by hand.
 */
async function trashPath(app, adapter, path) {
	const file = app.vault.getAbstractFileByPath(path);
	if (file) {
		await app.fileManager.trashFile(file);
		return 'obsidian-trash';
	}
	try {
		if (!(await adapter.exists('.trash'))) await adapter.mkdir('.trash');
		await adapter.rename(path, '.trash/' + splitPath(path).base);
		return 'vault-trash';
	} catch (_) {
		/*
		 * Even a failed rescue beats deleting it outright: the file stays
		 * where it is and the next sync reports the difference again.
		 */
		return 'kept';
	}
}

/**
 * A full two-way sync: work out what moved on both sides, then apply it.
 *
 * @param {object} io  everything that touches the world, injected so the
 *   whole engine can be driven by fakes:
 *   {readBytes, writeBytes, trash, listLocal, base, saveBase, now}
 */
async function githubSync(client, repo, branch, io, opts) {
	opts = opts || {};

	const collected = await io.listLocal();

	/*
	 * The local side is read first because bootstrapping an empty repository
	 * needs a real file to make the root commit out of — see bootstrapBranch
	 * for why an empty repository cannot be written any other way.
	 */
	let headSha = await client.getRef(repo, branch);
	if (!headSha && collected.files.length && !opts.dryRun) {
		const first = collected.files[0];
		const bytes = await io.readBytes(first.path);
		headSha = await client.bootstrapBranch(
			repo,
			branch,
			first.path,
			bytesToBase64(bytes),
			(opts.message || 'jemzsync') + ' — first commit'
		);
	}

	let baseTree = null;
	let remote = Object.create(null);
	if (headSha) {
		const commit = await client.getCommit(repo, headSha);
		baseTree = commit.tree;
		remote = await client.readTree(repo, baseTree);
	}
	const local = Object.create(null);
	for (let i = 0; i < collected.files.length; i++) {
		local[collected.files[i].path] = collected.files[i].sha;
	}

	/*
	 * A file we could not read is not a file that was deleted. Carrying its
	 * last-known hash into both the local and base views makes it look
	 * untouched, so nothing happens to it on either side.
	 */
	for (let i = 0; i < collected.errors.length; i++) {
		const p = collected.errors[i].path;
		if (io.base[p]) local[p] = io.base[p];
	}

	/*
	 * Sanity-check the read before trusting it with deletions.
	 *
	 * If the branch is still exactly where our own last push left it, then
	 * nobody else has committed, so the tree we just read must contain
	 * everything we put there. When it does not, the read is stale — GitHub
	 * will occasionally serve a tree from just before a very recent commit —
	 * and believing it means concluding that files we created seconds ago were
	 * deleted by someone else, and removing them locally.
	 *
	 * That is exactly what happened on a real vault: a note was pushed
	 * successfully and then deleted off the disk moments later.
	 */
	if (opts.lastCommit && headSha === opts.lastCommit) {
		const missing = [];
		const known = Object.keys(io.base);
		for (let i = 0; i < known.length; i++) {
			if (!(known[i] in remote)) missing.push(known[i]);
		}
		if (missing.length) {
			throw new Error(
				'GitHub returned an incomplete view of the branch (' +
					missing.length +
					' known file(s) missing). Syncing stopped rather than risk deleting them.'
			);
		}
	}

	const plan = buildSyncPlan(io.base, local, remote);
	plan.remoteTree = remote;
	plan.headSha = headSha;

	/*
	 * Last line of defence. Any bug that makes the vault look empty — a failed
	 * scan, a permissions problem, a wrong folder — turns into "delete
	 * everything" without this. A handful of deletions is ordinary; most of
	 * the repository disappearing at once never is.
	 */
	const remoteCount = Object.keys(remote).length;
	const removing = plan.deleteRemote.length;
	if (!opts.confirmedBulkDelete && remoteCount >= 4 && removing > remoteCount / 2) {
		throw new Error(
			'This sync would remove ' +
				removing +
				' of ' +
				remoteCount +
				' files from the repository. That is more than looks like an ordinary edit, so it has been stopped. Sync from the panel to review and confirm it.'
		);
	}

	if (syncPlanIsEmpty(plan)) {
		/*
		 * Being already in step IS an agreement, and it has to be written
		 * down. Returning here without recording it left the device with no
		 * memory of ever having agreed — so the next edit made on the other
		 * side compared against an empty base, looked like a change on both
		 * sides at once, and was reported as a conflict that never happened.
		 *
		 * It bites hardest on a fresh repository, where the first sync only
		 * bootstraps and therefore has nothing else to do.
		 */
		if (!opts.dryRun) {
			await io.saveBase(Object.assign(Object.create(null), remote), headSha);
		}
		return { plan: plan, applied: false, reason: 'in-sync', commit: headSha };
	}
	if (opts.dryRun) {
		return { plan: plan, applied: false, reason: 'dry-run', commit: headSha };
	}

	/*
	 * Adding files needs no permission. Overwriting or removing what is on
	 * this device does — it is the last moment at which a mistake is still
	 * cheap. The plan is handed back so the caller can show exactly what would
	 * happen, and nothing is touched until it comes back confirmed.
	 */
	if (!opts.confirmed && syncPlanIsDestructive(plan)) {
		return { plan: plan, applied: false, reason: 'needs-confirmation', commit: headSha };
	}

	const nextBase = Object.assign(Object.create(null), io.base);

	/* ---- incoming ---- */

	for (let i = 0; i < plan.pull.length; i++) {
		const item = plan.pull[i];
		const bytes = await client.readBlob(repo, item.sha);
		await io.writeBytes(item.path, bytes);
		nextBase[item.path] = item.sha;
	}

	for (let i = 0; i < plan.deleteLocal.length; i++) {
		// Trashed, never destroyed: a sync that removes a note has to be
		// recoverable on the device it removed it from.
		await io.trash(plan.deleteLocal[i].path);
		delete nextBase[plan.deleteLocal[i].path];
	}

	/* ---- conflicts: keep both, and let the existing UI sort it out ---- */

	const stamp = new Date(io.now ? io.now() : Date.now()).toISOString().slice(0, 10);
	for (let i = 0; i < plan.conflict.length; i++) {
		const c = plan.conflict[i];
		const bytes = await client.readBlob(repo, c.remoteSha);
		const copyPath = conflictCopyName(c.path, stamp);
		await io.writeBytes(copyPath, bytes);
		c.copyPath = copyPath;
		// The local version is still ours and still needs sending, so the
		// other device sees the disagreement too rather than only this one.
		plan.push.push({ path: c.path, sha: c.localSha, note: 'conflicted' });
	}

	/* ---- outgoing, as one commit ---- */

	let commitSha = headSha;
	const outgoing = plan.push.slice();
	const removals = plan.deleteRemote.slice();

	if (outgoing.length || removals.length) {
		const shaFor = Object.create(null);
		for (let i = 0; i < outgoing.length; i++) {
			const bytes = await io.readBytes(outgoing[i].path);
			shaFor[outgoing[i].path] = await client.createBlob(repo, bytesToBase64(bytes));
			if (opts.onProgress) opts.onProgress(i + 1, outgoing.length, outgoing[i].path);
		}

		const entries = buildTreeEntries(
			{ create: outgoing, update: [], remove: removals },
			shaFor
		);
		const treeSha = await client.createTree(repo, entries, baseTree);
		commitSha = await client.createCommit(
			repo,
			opts.message || 'jemzsync: sync vault',
			treeSha,
			headSha ? [headSha] : []
		);

		if (headSha) await client.updateRef(repo, branch, commitSha);
		else await client.createRef(repo, branch, commitSha);

		for (let i = 0; i < outgoing.length; i++) {
			nextBase[outgoing[i].path] = shaFor[outgoing[i].path];
		}
		for (let i = 0; i < removals.length; i++) delete nextBase[removals[i].path];

		// A conflict copy is a local file like any other; it goes up on the
		// next round rather than being special-cased here.
	}

	await io.saveBase(nextBase, commitSha);
	return { plan: plan, applied: true, reason: 'synced', commit: commitSha };
}

/* ================================================================== *
 * OBSIDIAN INTEGRATION
 * ================================================================== */

const Plugin = ob.Plugin;
const PluginSettingTab = ob.PluginSettingTab;
const ItemView = ob.ItemView;
const Modal = ob.Modal;
const Setting = ob.Setting;
const Notice = ob.Notice;
const Platform = ob.Platform;
const requestUrl = ob.requestUrl;

/**
 * The one place this plugin touches the network.
 *
 * `requestUrl` is Obsidian's own HTTP call. It is used rather than `fetch`
 * because it is not subject to CORS and because it is the only thing that
 * works on iOS and Android — where a plugin has no other way out. Nothing
 * here is called unless a GitHub token has been entered.
 */
function obsidianRequest(params) {
	if (typeof requestUrl !== 'function') {
		return Promise.reject(new Error('Network requests are unavailable in this build.'));
	}
	return requestUrl(params);
}

function currentPlatform() {
	if (Platform && Platform.isMobileApp) return 'mobile';
	if (Platform && Platform.isDesktopApp) return 'desktop';
	return 'unknown';
}

/** Which cloud this install has to use, read off Obsidian's platform flags. */
function currentEcosystem() {
	return detectEcosystem(Platform || {});
}

/**
 * A friendly default label for this device.
 *
 * Delegates to the pure `suggestDeviceName` so the rule is testable. It used
 * to read `isPhone` first, which is set on Android too — an Android phone
 * introduced itself to the other devices as "iPhone".
 */
function defaultDeviceName() {
	return suggestDeviceName(Platform || {});
}

/* ---------------------- per-device state ---------------------- *
 *
 * A small amount of state must NOT travel between devices, which rules out
 * `saveData`: that writes into the vault, and the whole premise here is that
 * the vault is being replicated by iCloud or Google Drive.
 *
 * `app.saveLocalStorage` / `app.loadLocalStorage` are Obsidian's own answer to
 * this. They stay on the device and, unlike the raw `localStorage` object,
 * they are scoped per vault — so two vaults open on the same Mac get separate
 * device identities instead of quietly sharing one.
 */

function readLocal(app, key) {
	try {
		if (app && typeof app.loadLocalStorage === 'function') {
			return app.loadLocalStorage(key);
		}
	} catch (_) {
		/* private mode, quota, or an older app — treat as absent */
	}
	return null;
}

function writeLocal(app, key, value) {
	try {
		if (app && typeof app.saveLocalStorage === 'function') {
			app.saveLocalStorage(key, value);
		}
	} catch (_) {
		/* best effort; a lost preference is not worth breaking a scan over */
	}
}

/**
 * This device's identity.
 *
 * Stored per device on purpose: settings live in the vault and therefore sync,
 * so an id kept there would hand every device the same identity and the
 * Devices panel could never tell them apart.
 */
function loadDeviceIdentity(app) {
	let id = readLocal(app, 'jemzsync-device-id');
	if (!id) {
		id = newDeviceId();
		writeLocal(app, 'jemzsync-device-id', id);
	}
	const chosen = readLocal(app, 'jemzsync-device-name');
	return {
		id: id,
		name: chosen || defaultDeviceName(),
		platform: defaultDeviceName(),
		/*
		 * Whether the name came from the user. A derived name may be adjusted
		 * once the beacons show who else is here; a chosen one never is.
		 */
		named: !!chosen,
	};
}

/*
 * The "don't warn me again" flag is per device for the same reason: dismissing
 * the setup warning on a correctly configured Mac must not silence it on an
 * iPhone that is still misconfigured.
 */
function loadDismissedWarning(app) {
	return readLocal(app, 'jemzsync-dismissed-location');
}

function saveDismissedWarning(app, code) {
	writeLocal(app, 'jemzsync-dismissed-location', code);
}

function saveDeviceName(app, name) {
	writeLocal(app, 'jemzsync-device-name', name);
}

/* ---------------------- paired device, per device ---------------------- *
 *
 * "The other device" is a different device depending on which one you are
 * standing at, so this cannot live in `saveData` — and once it is filled in
 * automatically, storing it there is actively harmful:
 *
 *   The Mac writes the iPhone's digest into the shared data.json. iCloud
 *   carries that file to the iPhone, which overwrites it with the Mac's
 *   digest, which comes back... forever. And because data.json sits in the
 *   vault, every one of those writes changes the vault fingerprint, so the
 *   two devices could never report a match again.
 *
 * Per-device storage removes the loop and the churn at once. Older versions
 * kept these in settings, so a value found there is migrated across once and
 * treated as hand-typed, which it must have been.
 */

const PAIRED_KEYS = {
	fingerprint: 'jemzsync-paired-fingerprint',
	fingerprintSource: 'jemzsync-paired-fingerprint-source',
	files: 'jemzsync-paired-files',
	bytes: 'jemzsync-paired-bytes',
	label: 'jemzsync-paired-label',
	labelSource: 'jemzsync-paired-label-source',
};

function loadPairing(app, settings) {
	settings = settings || {};

	let fingerprint = readLocal(app, PAIRED_KEYS.fingerprint);
	let fingerprintSource = readLocal(app, PAIRED_KEYS.fingerprintSource);
	let label = readLocal(app, PAIRED_KEYS.label);
	let labelSource = readLocal(app, PAIRED_KEYS.labelSource);

	// Migrate a value typed into an older version, once. The settings copy is
	// left alone rather than cleared: rewriting data.json here would change
	// the vault fingerprint on upgrade, which is the one thing this whole
	// change exists to avoid.
	if (!fingerprint && settings.pairedFingerprint) {
		fingerprint = String(settings.pairedFingerprint);
		fingerprintSource = 'manual';
		writeLocal(app, PAIRED_KEYS.fingerprint, fingerprint);
		writeLocal(app, PAIRED_KEYS.fingerprintSource, 'manual');
	}
	if (!label && settings.pairedDeviceLabel) {
		label = String(settings.pairedDeviceLabel);
		labelSource = 'manual';
		writeLocal(app, PAIRED_KEYS.label, label);
		writeLocal(app, PAIRED_KEYS.labelSource, 'manual');
	}

	return {
		fingerprint: fingerprint || '',
		fingerprintSource: fingerprintSource || '',
		files: Number(readLocal(app, PAIRED_KEYS.files)) || 0,
		bytes: Number(readLocal(app, PAIRED_KEYS.bytes)) || 0,
		label: label || '',
		labelSource: labelSource || '',
	};
}

function savePairing(app, pairing) {
	writeLocal(app, PAIRED_KEYS.fingerprint, pairing.fingerprint || '');
	writeLocal(app, PAIRED_KEYS.fingerprintSource, pairing.fingerprintSource || '');
	writeLocal(app, PAIRED_KEYS.files, String(pairing.files || 0));
	writeLocal(app, PAIRED_KEYS.bytes, String(pairing.bytes || 0));
	writeLocal(app, PAIRED_KEYS.label, pairing.label || '');
	writeLocal(app, PAIRED_KEYS.labelSource, pairing.labelSource || '');
}

/* ---------------------- GitHub, per device ---------------------- *
 *
 * The access token is the single most sensitive thing this plugin handles,
 * and `saveData` is the one place it must never go. `saveData` writes into
 * the vault — the vault that iCloud replicates to every device, and that
 * we are about to commit to a Git repository. A token stored there would
 * be copied to every device and then published into the repo it unlocks.
 *
 * So it lives here, in per-device storage, alongside the device id: on
 * this machine, never synced, never in a commit. The repository choice
 * sits beside it for the same reason — each device is set up once, by its
 * owner, and nothing about that has to travel.
 */

const GITHUB_KEYS = {
	mode: 'jemzsync-storage-mode',
	token: 'jemzsync-github-token',
	login: 'jemzsync-github-login',
	repo: 'jemzsync-github-repo',
	branch: 'jemzsync-github-branch',
	lastCommit: 'jemzsync-github-last-commit',
	lastSyncAt: 'jemzsync-github-last-sync',
	notesOnly: 'jemzsync-github-notes-only',
};

function loadGithubConfig(app) {
	const mode = readLocal(app, GITHUB_KEYS.mode) || STORAGE_ECOSYSTEM;
	return {
		mode: mode,
		token: readLocal(app, GITHUB_KEYS.token) || '',
		login: readLocal(app, GITHUB_KEYS.login) || '',
		repo: readLocal(app, GITHUB_KEYS.repo) || '',
		branch: readLocal(app, GITHUB_KEYS.branch) || 'main',
		lastCommit: readLocal(app, GITHUB_KEYS.lastCommit) || '',
		lastSyncAt: Number(readLocal(app, GITHUB_KEYS.lastSyncAt)) || 0,
		notesOnly: readLocal(app, GITHUB_KEYS.notesOnly) === 'true',
	};
}

function saveGithubConfig(app, cfg) {
	writeLocal(app, GITHUB_KEYS.mode, cfg.mode || STORAGE_ECOSYSTEM);
	writeLocal(app, GITHUB_KEYS.token, cfg.token || '');
	writeLocal(app, GITHUB_KEYS.login, cfg.login || '');
	writeLocal(app, GITHUB_KEYS.repo, cfg.repo || '');
	writeLocal(app, GITHUB_KEYS.branch, cfg.branch || 'main');
	writeLocal(app, GITHUB_KEYS.lastCommit, cfg.lastCommit || '');
	writeLocal(app, GITHUB_KEYS.lastSyncAt, String(cfg.lastSyncAt || 0));
	writeLocal(app, GITHUB_KEYS.notesOnly, cfg.notesOnly ? 'true' : 'false');
}

/**
 * The last state this device and the repository agreed on.
 *
 * Per device, because it describes what *this* device last saw — and it must
 * not sync, or every device would inherit another's idea of the past and
 * mistake untouched files for changes.
 *
 * Stored as JSON. A very large vault could outgrow the storage quota, in
 * which case the write is dropped and the next sync simply has no base: it
 * then treats a difference on both sides as a conflict and keeps both copies,
 * which is the safe way to be wrong.
 */
function loadSyncBase(app) {
	const raw = readLocal(app, 'jemzsync-github-base');
	if (!raw) return Object.create(null);
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : Object.create(null);
	} catch (_) {
		return Object.create(null);
	}
}

function saveSyncBase(app, base) {
	try {
		writeLocal(app, 'jemzsync-github-base', JSON.stringify(base));
	} catch (_) {
		/* quota — the next sync falls back to conflict-and-keep-both */
	}
}

/** Never show a token in full; enough to recognise, not enough to use. */
function maskToken(token) {
	const t = String(token || '');
	if (!t) return '';
	if (t.length <= 12) return '••••';
	return t.slice(0, 7) + '…' + t.slice(-4);
}

/**
 * What, if anything, is wrong with the GitHub setup.
 *
 * The counterpart to `classifyVaultLocation`: in GitHub mode the vault's
 * folder is no longer the thing that can be misconfigured, so these are
 * the failures worth surfacing instead.
 */
function classifyGithubHealth(cfg, now) {
	if (!storageUsesGithub(cfg.mode)) return { ok: true, code: 'unused', title: '', detail: '' };

	if (!cfg.token) {
		return {
			ok: false,
			code: 'not-connected',
			title: 'Not connected to GitHub',
			detail:
				cfg.mode === STORAGE_GITHUB
					? 'This vault is set to sync through GitHub, but no account is connected — so nothing is being saved anywhere. Connect one, or change where the vault is stored.'
					: 'GitHub is switched on as a second copy, but no account is connected yet.',
		};
	}
	if (!cfg.repo) {
		return {
			ok: false,
			code: 'no-repo',
			title: 'No repository chosen',
			detail: 'Connected as ' + (cfg.login || 'your account') + ', but no repository is selected yet.',
		};
	}
	if (!cfg.lastSyncAt) {
		return {
			ok: false,
			code: 'never-synced',
			title: 'Never synced',
			detail: 'Set up and ready, but nothing has been sent to ' + cfg.repo + ' yet.',
		};
	}

	const days = (now - cfg.lastSyncAt) / (24 * 3600 * 1000);
	if (days >= 7) {
		return {
			ok: false,
			code: 'stale',
			title: 'Not synced for ' + Math.floor(days) + ' days',
			detail: 'The last successful sync to ' + cfg.repo + ' was a while ago.',
		};
	}

	return {
		ok: true,
		code: 'ok',
		title: 'Syncing with ' + cfg.repo,
		detail: 'Last sync ' + timeAgo(cfg.lastSyncAt) + '.',
	};
}

/**
 * Fold what the beacons reported into the stored pairing.
 *
 * Kept separate from the plugin class so the whole rule — including "never
 * overwrite a typed value" — is testable without an Obsidian app.
 *
 * @returns {{pairing: object, changed: boolean}}
 */
function applyPairingAutofill(pairing, others, now) {
	const picked = pickPairedBeacon(others, now);
	if (!picked) return { pairing: pairing, changed: false };

	const fp = autofillValue(
		pairing.fingerprint,
		pairing.fingerprintSource,
		picked.fingerprint.digest
	);
	const nm = autofillValue(pairing.label, pairing.labelSource, picked.name);

	const next = {
		fingerprint: fp.value,
		fingerprintSource: fp.source,
		label: nm.value,
		labelSource: nm.source,
		files: pairing.files,
		bytes: pairing.bytes,
	};

	// File counts only mean anything next to the digest they came from. Carry
	// them when the stored digest is the detected one, and drop them when it
	// is not — a hand-typed digest has no counts, and pretending otherwise is
	// what made the panel report "same file count" for vaults that differed.
	if (fp.value === picked.fingerprint.digest) {
		next.files = picked.fingerprint.files || 0;
		next.bytes = picked.fingerprint.bytes || 0;
	} else {
		next.files = 0;
		next.bytes = 0;
	}

	const changed =
		next.fingerprint !== pairing.fingerprint ||
		next.fingerprintSource !== pairing.fingerprintSource ||
		next.label !== pairing.label ||
		next.labelSource !== pairing.labelSource ||
		next.files !== pairing.files ||
		next.bytes !== pairing.bytes;

	return { pairing: next, changed: changed };
}

/**
 * Put text on the clipboard.
 *
 * The single place this plugin touches the clipboard, and it only ever writes.
 * jemzsync never reads it, so nothing you copied from elsewhere is visible
 * here. Every caller is a button or command the user pressed, and what goes
 * across is either a sixteen-character digest or a block of shell commands.
 *
 * Writing can be refused — an unfocused window is enough — so failure falls
 * back to telling the user rather than throwing into a click handler.
 */
async function copyToClipboard(text, message) {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(message);
	} catch (_) {
		new Notice('Could not reach the clipboard. Select the text and copy it by hand.');
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
		this.identity = loadDeviceIdentity(this.app);
		this.pairing = loadPairing(this.app, this.settings);
		this.github = loadGithubConfig(this.app);
		this.ecosystem = currentEcosystem();
		this.liveTimer = null;

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
			/*
			 * The id must not change — user hotkeys are bound to it. Only the
			 * label moves, because "iCloud" was showing in the command palette
			 * on Windows, Android and Linux too.
			 */
			id: 'check-setup',
			name: 'Check sync setup',
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
				await copyToClipboard(
					scan.fingerprint.digest,
					'Fingerprint copied. Paste it on your other device.'
				);
			},
		});

		this.addCommand({
			id: 'push-to-github',
			name: 'Sync vault with GitHub',
			checkCallback: (checking) => {
				const ready = storageUsesGithub(this.github.mode) && !!this.github.token && !!this.github.repo;
				if (checking) return ready;
				if (!ready) return false;
				this.syncWithGithub({})
					.then((res) =>
						new Notice(
							res.applied ? describeSyncPlan(res.plan) + '.' : 'Already in sync.'
						)
					)
					.catch((err) => new Notice(String((err && err.message) || err)));
				return true;
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

		if (this.settings.watchVault) this.startWatching();
		this.startGithubAutoSync();
	}

	/**
	 * React to vault changes as they happen, so the panel and the beacon reflect
	 * reality within seconds instead of on the next poll. Files arriving from
	 * the cloud fire these events too, which is what makes an incoming sync from
	 * another device show up on its own.
	 */
	startWatching() {
		const onChange = (file) => {
			const path = file && (file.path || file);
			if (!shouldRescanForChange(path, this.settings)) return;
			this.scheduleLiveScan();
			// Files we just wrote ourselves must not start another round.
			if (!this.applyingRemote) this.scheduleGithubSync();
		};
		const vault = this.app.vault;
		this.registerEvent(vault.on('create', onChange));
		this.registerEvent(vault.on('modify', onChange));
		this.registerEvent(vault.on('delete', onChange));
		this.registerEvent(vault.on('rename', onChange));
	}

	/** Collapse a burst of changes into a single scan. */
	scheduleLiveScan() {
		if (this.liveTimer) window.clearTimeout(this.liveTimer);
		this.liveTimer = window.setTimeout(() => {
			this.liveTimer = null;
			this.runScan(false).catch(() => {});
		}, LIVE_SCAN_DEBOUNCE_MS);
	}

	/**
	 * Tell the user once, up front, when the vault cannot possibly sync.
	 * The dismissal is per device and per problem — see loadDismissedWarning.
	 */
	maybeWarnAboutLocation(scan) {
		if (!this.settings.warnOnBadLocation) return;
		if (!shouldWarnAboutLocation(scan.location, loadDismissedWarning(this.app))) return;
		if (this.setupModalOpen) return;
		try {
			this.setupModalOpen = true;
			new SetupModal(this.app, this, scan.location).open();
		} catch (_) {
			this.setupModalOpen = false;
		}
	}

	onunload() {
		if (this.liveTimer) window.clearTimeout(this.liveTimer);
		if (this.githubTimer) window.clearTimeout(this.githubTimer);
		/* Obsidian detaches leaves, events and intervals registered above. */
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
		scan.ecosystem = this.ecosystem;
		scan.location = classifyVaultLocation(vaultBasePath(this.app), {
			platform: currentPlatform(),
			vaultName: this.app.vault.getName(),
			ecosystem: this.ecosystem,
			storageMode: this.github.mode,
		});
		scan.githubHealth = classifyGithubHealth(this.github, Date.now());
		await this.syncBeacons(scan);
		this.lastScan = scan;

		this.maybeWarnAboutLocation(scan);

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
			scan.devices = summarizeDevices(
				split.others,
				scan.fingerprint,
				Date.now(),
				BEACON_STALE_MS,
				transportName(this.ecosystem)
			);

			this.autoNameThisDevice(split.others);
			this.autofillPairing(split.others);

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

	/**
	 * Give this device a name that is distinct from the others, unless the user
	 * has chosen one — in which case it is left completely alone.
	 *
	 * Not persisted: it is derived from whoever else is currently in the vault,
	 * so re-deriving it each scan keeps it right as devices come and go. What
	 * *is* persisted is only ever a name typed in settings.
	 */
	autoNameThisDevice(others) {
		if (this.identity.named) return;
		const derived = disambiguateDeviceName(
			defaultDeviceName(),
			freshBeacons(others, Date.now()),
			this.identity.id
		);
		if (derived === this.identity.name) return;
		this.identity.name = derived;
	}

	/**
	 * Fill the paired-device fields from whichever beacon looks most useful.
	 *
	 * Writes to per-device storage, never through `saveSettings` — see the note
	 * above `loadPairing` for why putting this in the vault would make the two
	 * devices fight over it forever.
	 */
	autofillPairing(others) {
		const result = applyPairingAutofill(this.pairing, others, Date.now());
		if (!result.changed) return;
		this.pairing = result.pairing;
		savePairing(this.app, this.pairing);
		this.refreshViews();
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

	/* ---------------------- GitHub ---------------------- */

	/** A client for the connected account, or null when there is none. */
	githubClient() {
		if (!this.github.token) return null;
		return githubClient(this.github.token, obsidianRequest);
	}

	/**
	 * Check a token and remember who it belongs to.
	 *
	 * Nothing is stored until GitHub has confirmed the token works, so a
	 * mistyped one cannot be saved and quietly fail later.
	 */
	async connectGithub(token) {
		const client = githubClient(String(token || '').trim(), obsidianRequest);
		const me = await client.whoami();
		this.github.token = String(token || '').trim();
		this.github.login = me.login;
		saveGithubConfig(this.app, this.github);
		return me;
	}

	disconnectGithub() {
		this.github.token = '';
		this.github.login = '';
		this.github.repo = '';
		this.github.lastCommit = '';
		this.github.lastSyncAt = 0;
		saveGithubConfig(this.app, this.github);
		this.refreshViews();
	}

	/**
	 * Work out what a push would do, without doing it.
	 *
	 * Used both for the preview and for the confirmation step, so that what
	 * the user is shown and what actually happens come from the same code
	 * rather than two descriptions that can drift apart.
	 */

	/**
	 * Send the vault to the repository.
	 *
	 * @param {object} opts {force} — `force` here only means "the user has
	 *   already confirmed a destructive change", never a Git force-push.
	 */

	/**
	 * A full two-way sync with the repository.
	 *
	 * This is what makes GitHub a transport rather than a backup: edits made
	 * here go up, edits made elsewhere come down, and anything both sides
	 * touched is kept twice rather than resolved by guesswork.
	 */
	async syncWithGithub(opts) {
		opts = opts || {};
		const client = this.githubClient();
		if (!client) throw new Error('Connect a GitHub account first.');
		if (!this.github.repo) throw new Error('Choose a repository first.');
		if (this.syncing) return { plan: null, applied: false, reason: 'already-running' };

		this.syncing = true;
		/*
		 * Remembered so a failure is visible. Automatic syncing that fails
		 * quietly is the worst possible behaviour: the panel goes on looking
		 * healthy while nothing has left the device for days.
		 */
		this.lastSyncError = this.lastSyncError || null;
		/*
		 * Writing pulled files into the vault fires Obsidian's own change
		 * events, which would schedule a scan, which would sync, which would
		 * write... This is the same feedback loop the beacons already guard
		 * against, and it gets the same treatment.
		 */
		this.applyingRemote = true;

		const adapter = this.app.vault.adapter;
		try {
			const scan = await scanVault(adapter, this.settings);
			this.syncAttemptedAt = Date.now();

			assertScanComplete(scan);
			const io = {
				base: loadSyncBase(this.app),
				listLocal: async () => {
					const collected = await collectPushable(
						async () => scan.entries.map((e) => ({ path: e.path, size: e.size })),
						async (p) => new Uint8Array(await adapter.readBinary(p)),
						{ notesOnly: this.github.notesOnly }
					);
					// Offloaded files exist but cannot be read; never deleted.
					const unreadable = unreadableFromScan(scan);
					for (let i = 0; i < unreadable.length; i++) {
						collected.errors.push(unreadable[i]);
					}
					return collected;
				},
				readBytes: async (p) => new Uint8Array(await adapter.readBinary(p)),
				writeBytes: async (p, bytes) => {
					const dir = splitPath(p).dir;
					if (dir) {
						try {
							if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
						} catch (_) {
							/* raced with another writer; it exists either way */
						}
					}
					await adapter.writeBinary(p, bytes.buffer.slice(
						bytes.byteOffset,
						bytes.byteOffset + bytes.byteLength
					));
				},
				trash: (p) => trashPath(this.app, adapter, p),
				saveBase: async (base, commit) => {
					saveSyncBase(this.app, base);
					this.github.lastCommit = commit || '';
					this.github.lastSyncAt = Date.now();
					saveGithubConfig(this.app, this.github);
				},
			};

			const result = await githubSync(
				client,
				this.github.repo,
				this.github.branch,
				io,
				{
					dryRun: opts.dryRun,
					onProgress: opts.onProgress,
					message: 'jemzsync: ' + this.identity.name,
					lastCommit: this.github.lastCommit,
					confirmed: !!opts.confirmed,
					confirmedBulkDelete: !!opts.confirmed,
				}
			);
			this.lastSyncError = null;
			return result;
		} finally {
			this.syncing = false;
			// Give Obsidian's watcher a moment to deliver the events caused by
			// our own writes before listening to it again.
			window.setTimeout(() => {
				this.applyingRemote = false;
				/*
				 * An edit you made while a sync happened to be running is a
				 * real edit. Suppressing the loop must not swallow it — before
				 * this, such an edit fell out of the fast path entirely and sat
				 * unsent until the next poll, minutes later.
				 */
				if (this.syncWanted) {
					this.syncWanted = false;
					this.scheduleGithubSync();
				}
			}, 2000);
			this.refreshViews();
		}
	}

	/**
	 * Keep the repository up to date without being asked.
	 *
	 * GitHub cannot notify a plugin that something changed, so "live" here
	 * means two things: send within seconds of you stopping typing, and check
	 * for other devices' work on a timer. The send is immediate because that
	 * is the half that loses data if it is late.
	 */
	/**
	 * Is GitHub syncing switched on, right now?
	 *
	 * Asked afresh every time rather than once at startup. The storage mode is
	 * a setting the user changes mid-session, and reading it only when the
	 * timer was created meant a vault switched to cloud-only carried on
	 * committing to GitHub until Obsidian restarted — and one switched the
	 * other way never started at all.
	 */
	githubReady() {
		return (
			storageUsesGithub(this.github.mode) &&
			!!this.github.token &&
			!!this.github.repo
		);
	}

	startGithubAutoSync() {
		// Registered unconditionally; the mode is checked when it fires.
		const minutes = Math.max(1, Number(this.settings.githubPullMinutes) || 5);
		this.registerInterval(
			window.setInterval(() => {
				if (!this.githubReady()) return;
				this.autoSync();
			}, minutes * 60 * 1000)
		);

		this.app.workspace.onLayoutReady(() => {
			if (!this.githubReady()) return;
			this.autoSync();
		});
	}

	/** Debounced push after local edits settle. */
	/**
	 * Run a sync, recover from the one failure that is expected, and make
	 * anything else visible.
	 *
	 * A 422 means another device committed between reading the branch and
	 * writing it. That is not an error so much as an instruction: re-read and
	 * merge. Refusing to force-push and then giving up would leave the two
	 * devices stuck apart forever, which is the opposite of the point.
	 */
	autoSync(retriesLeft) {
		const retries = retriesLeft === undefined ? 1 : retriesLeft;
		return this.syncWithGithub({})
			.then((r) => {
				if (r && r.reason === 'already-running') this.scheduleGithubSync();
				if (r && r.reason === 'needs-confirmation') {
					/*
					 * Automatic means automatic for additions, not for
					 * deletions. Something that would overwrite or remove your
					 * work waits for you to look at it.
					 */
					this.pendingPlan = r.plan;
					if (!this.pendingNoticeShown) {
						this.pendingNoticeShown = true;
						new Notice(
							'jemzsync: ' +
								describeSyncPlan(r.plan) +
								'. Open the jemzsync panel and press Sync now to review it.'
						);
					}
					this.refreshViews();
				} else {
					this.pendingPlan = null;
					this.pendingNoticeShown = false;
				}
				return r;
			})
			.catch((err) => {
				const message = String((err && err.message) || err);

				// The race: re-read the branch and merge, rather than stopping.
				if (err && err.status === 422 && retries > 0) {
					return new Promise((resolve) => {
						window.setTimeout(() => resolve(this.autoSync(retries - 1)), 1500);
					});
				}

				const first = this.lastSyncError !== message;
				this.lastSyncError = message;
				this.lastSyncErrorAt = Date.now();
				// Once per distinct problem, so a broken token is noticed but a
				// flaky connection does not produce a stream of popups.
				if (first) new Notice('jemzsync could not sync with GitHub: ' + message);
				this.refreshViews();
			});
	}

	scheduleGithubSync() {
		if (!this.githubReady()) return;
		if (!this.settings.githubAutoSync) return;
		// Mid-sync, the change is remembered rather than dropped.
		if (this.applyingRemote || this.syncing) {
			this.syncWanted = true;
			return;
		}

		if (this.githubTimer) window.clearTimeout(this.githubTimer);
		this.githubTimer = window.setTimeout(() => {
			this.githubTimer = null;
			this.autoSync();
		}, GITHUB_SYNC_DEBOUNCE_MS);
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

/* ---------------------- setup popup ---------------------- */

/**
 * Shown when the vault sits somewhere it cannot sync from. This is the one
 * moment interrupting the user is worth it: until the vault moves, nothing
 * else the plugin reports means anything.
 */
class SetupModal extends Modal {
	constructor(app, plugin, location) {
		super(app);
		this.plugin = plugin;
		this.location = location;
	}

	onOpen() {
		const el = this.contentEl;
		el.empty();
		el.addClass('jemzsync-modal');

		const eco = ecosystemInfo(this.plugin.ecosystem);

		el.createEl('h2', { text: this.location.title });
		el.createEl('p', {
			cls: 'jemzsync-modal-detail',
			text: this.location.detail,
		});
		el.createEl('p', {
			cls: 'jemzsync-modal-detail',
			text:
				'This looks like ' +
				eco.label +
				', so your notes belong in ' +
				eco.cloud +
				'. Move the vault into ' +
				eco.folderHint +
				' — or create a new vault there and copy your notes across.',
		});

		if (this.location.fixes && this.location.fixes.length) {
			const ol = el.createEl('ol', { cls: 'jemzsync-fixes' });
			for (let i = 0; i < this.location.fixes.length; i++) {
				ol.createEl('li', { text: this.location.fixes[i] });
			}
		}

		const plan = buildMigrationPlan(
			vaultBasePath(this.plugin.app),
			this.plugin.app.vault.getName(),
			this.plugin.ecosystem
		);
		if (plan.shell && currentPlatform() === 'desktop') {
			const pre = el.createEl('pre', { cls: 'jemzsync-shell' });
			pre.createEl('code', { text: plan.shell });
		}

		const row = el.createDiv({ cls: 'jemzsync-actions' });

		const openBtn = row.createEl('button', { text: 'Show me in the panel' });
		openBtn.addEventListener('click', () => {
			this.close();
			this.plugin.activateView();
		});

		if (plan.shell && currentPlatform() === 'desktop') {
			const copyBtn = row.createEl('button', { text: 'Copy commands' });
			copyBtn.addEventListener('click', async () => {
				await copyToClipboard(plan.shell, 'Commands copied.');
			});
		}

		const hideBtn = row.createEl('button', { text: "Don't warn me again" });
		hideBtn.addEventListener('click', () => {
			saveDismissedWarning(this.app, this.location.code);
			this.close();
		});
	}

	onClose() {
		this.plugin.setupModalOpen = false;
		this.contentEl.empty();
	}
}

/* ---------------------- GitHub modals ---------------------- */

/**
 * The "i" beside each credential field.
 *
 * Two topics, because two questions get asked. The SSH one exists precisely
 * because there is no SSH field: "where do I put my key?" is the reasonable
 * first assumption for anyone used to `git push`, and answering it in the
 * plugin is better than leaving someone hunting for a box that cannot exist.
 */
const HELP_TOPICS = {
	token: {
		title: 'How to create a GitHub access token',
		intro:
			'jemzsync talks to GitHub over its REST API, which authenticates with a personal access token sent in an HTTP header.',
		steps: [
			'On github.com, open Settings → Developer settings → Personal access tokens.',
			'Choose "Fine-grained tokens" → Generate new token.',
			'Under "Repository access", pick "Only select repositories" and choose the one repository holding your vault.',
			'Under "Repository permissions", set Contents to "Read and write". That is the only permission jemzsync needs.',
			'Metadata is set to Read automatically — leave it.',
			'Generate the token, copy it, and paste it into the field here. GitHub shows it once.',
		],
		tableTitle: 'Permissions to grant',
		table: [
			['Contents', 'Read and write', 'reading and committing your notes — the only one required'],
			['Metadata', 'Read (automatic)', 'looking up the repository and its default branch'],
		],
		notes: [
			'A classic token works too, but it needs the whole "repo" scope, which grants access to every repository you own. A fine-grained token limited to one repository is much safer for notes.',
			'Never grant admin, delete_repo, or workflow. jemzsync neither needs nor uses them.',
			'The token is stored on this device only. It is never written into the vault and never committed to the repository.',
			'If a token is ever exposed, revoke it at Settings → Developer settings and generate a new one. Revoking takes effect immediately.',
		],
	},
	fingerprint: {
		title: 'How to get another device\'s fingerprint',
		intro:
			'Usually you do not have to. Every device running jemzsync in this vault announces its own fingerprint, and this field fills itself in — that is what "Filled in automatically" means when it appears under the field. These are the ways to fetch one by hand.',
		steps: [
			'On the other device, open the jemzsync panel — the cloud icon in the left ribbon on a computer, or the ribbon in the sidebar on a phone or tablet.',
			'Find the "Vault fingerprint" card and press Copy. A digest looks like a1b2c3d4-e5f6a7b8.',
			'Or run "Copy vault fingerprint" from the command palette. That works identically on every platform, which makes it the easier route on a phone.',
			'Send it across however you like, and paste it here. Anything you type into this field is yours and is never overwritten.',
		],
		tableTitle: 'Where to find it on each kind of device',
		table: [
			['Computer', 'cloud icon in the left ribbon, or the command palette'],
			['Phone or tablet', 'open the left sidebar, then the jemzsync ribbon icon; or use the command palette'],
			['Any platform', 'command palette → "Copy vault fingerprint"'],
		],
		notes: [
			'Both devices need to have scanned recently for the comparison to mean anything: a digest describes the files as they were at the moment of that scan.',
			'Matching digests mean both devices hold the same files at the same sizes. Modification times are deliberately excluded, because clouds restamp files for reasons that have nothing to do with content.',
			'Per-device clutter is excluded too — pane layout, .DS_Store, the announcements themselves and jemzsync\'s own files — so two correctly synced devices are not reported as differing.',
			'If this field stays empty, no other device has announced itself yet. Check that jemzsync is enabled there and that "Announce this device" is switched on.',
			'Clearing the field hands it back to automatic detection.',
		],
	},
	ssh: {
		title: 'Why there is no SSH key field',
		intro:
			'If you are used to "git push", expecting an SSH key here is reasonable — but an SSH key cannot authenticate what this plugin does, on any platform.',
		steps: [
			'SSH authenticates the git command line, which opens a raw TCP connection to github.com on port 22.',
			'An Obsidian plugin is JavaScript in a sandbox. It is given exactly two network functions, request and requestUrl, and both speak HTTPS only.',
			'There is no socket API to open, so there is nothing for an SSH key to authenticate — and on phones and tablets there never will be.',
			'GitHub\'s REST API, which is what jemzsync uses instead, takes a token in a header and does not accept SSH keys at all.',
		],
		table: [],
		notes: [
			'Your SSH keys still work perfectly for git on the command line. Nothing here changes that, and jemzsync never reads them.',
			'A private key should never be pasted into an application in any case. Use an access token, which you can scope to a single repository and revoke on its own.',
		],
	},
};

class HelpModal extends Modal {
	constructor(app, topic) {
		super(app);
		this.topic = topic;
	}

	onOpen() {
		const help = HELP_TOPICS[this.topic] || HELP_TOPICS.token;
		const el = this.contentEl;
		el.empty();
		el.addClass('jemzsync-modal');

		el.createEl('h2', { text: help.title });
		el.createEl('p', { cls: 'jemzsync-modal-detail', text: help.intro });

		const ol = el.createEl('ol', { cls: 'jemzsync-fixes' });
		for (let i = 0; i < help.steps.length; i++) {
			ol.createEl('li', { text: help.steps[i] });
		}

		if (help.table && help.table.length) {
			el.createEl('div', { cls: 'jemzsync-card-title', text: help.tableTitle || 'Details' });
			const list = el.createEl('ul', { cls: 'jemzsync-list' });
			for (let i = 0; i < help.table.length; i++) {
				list.createEl('li', { text: help.table[i].join(' — ') });
			}
		}

		el.createEl('div', { cls: 'jemzsync-card-title', text: 'Worth knowing' });
		const notes = el.createEl('ul', { cls: 'jemzsync-list' });
		for (let i = 0; i < help.notes.length; i++) {
			notes.createEl('li', { text: help.notes[i] });
		}

		const row = el.createDiv({ cls: 'jemzsync-actions' });
		row.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Pick a repository from the account's own, private ones included. */
class RepoPickerModal extends Modal {
	constructor(app, repos, onPick) {
		super(app);
		this.repos = repos || [];
		this.onPick = onPick;
	}

	onOpen() {
		const el = this.contentEl;
		el.empty();
		el.addClass('jemzsync-modal');
		el.createEl('h2', { text: 'Choose a repository' });

		if (!this.repos.length) {
			el.createEl('p', {
				cls: 'jemzsync-modal-detail',
				text: 'This account owns no repositories, or the token was not granted access to any. A fine-grained token only sees the repositories you selected when you created it.',
			});
			return;
		}

		el.createEl('p', {
			cls: 'jemzsync-modal-detail',
			text: 'A private repository is the right choice for notes. Every device has to point at the same one.',
		});

		const list = el.createDiv({ cls: 'jemzsync-repo-list' });
		for (let i = 0; i < this.repos.length; i++) {
			const r = this.repos[i];
			const row = list.createDiv({ cls: 'jemzsync-repo' });
			row.createEl('div', {
				cls: 'jemzsync-repo-name',
				text: r.full + (r.private ? '  · private' : '  · public'),
			});
			row.createEl('div', {
				cls: 'jemzsync-device-meta',
				/*
				 * No "empty" label here. GitHub's `size` is in kilobytes and
				 * updates lazily after a push, so a repository holding a real
				 * vault reports 0 for a while — the picker was calling a
				 * populated repository empty. An unreliable signal is worse
				 * than none.
				 */
				text: 'branch ' + r.defaultBranch,
			});
			const btn = row.createEl('button', { text: 'Use this' });
			btn.addEventListener('click', () => {
				this.close();
				this.onPick(r);
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Show exactly what a push will do before it does it.
 *
 * Adding files needs no permission. Changing or removing them does — this
 * is the last point at which a mistake is still cheap.
 */
/**
 * Show exactly what a sync will do before it does it.
 *
 * Only appears when something would be overwritten or removed. Pure additions
 * apply without interruption, because there is nothing to lose.
 */
class SyncConfirmModal extends Modal {
	constructor(app, plan, repo, onConfirm) {
		super(app);
		this.plan = plan;
		this.repo = repo;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const el = this.contentEl;
		el.empty();
		el.addClass('jemzsync-modal');
		el.createEl('h2', { text: 'Apply these changes?' });
		el.createEl('p', {
			cls: 'jemzsync-modal-detail',
			text: describeSyncPlan(this.plan) + ' · ' + this.repo,
		});

		const section = (title, items, render) => {
			if (!items.length) return;
			el.createEl('div', { cls: 'jemzsync-card-title', text: title });
			const ul = el.createEl('ul', { cls: 'jemzsync-list' });
			for (let i = 0; i < Math.min(15, items.length); i++) {
				ul.createEl('li', { text: render(items[i]) });
			}
			if (items.length > 15) {
				ul.createEl('li', { text: '…and ' + (items.length - 15) + ' more' });
			}
		};

		section('Will be overwritten on this device', this.plan.pull, (f) => f.path);
		section('Will be moved to this device\'s trash', this.plan.deleteLocal, (f) => f.path);
		section('Will be sent to the repository', this.plan.push, (f) => f.path);
		section('Will be removed from the repository', this.plan.deleteRemote, (f) => f.path);
		section(
			'Edited in both places — both versions will be kept',
			this.plan.conflict,
			(c) => c.path
		);

		const row = el.createDiv({ cls: 'jemzsync-actions' });
		const go = row.createEl('button', { text: 'Apply' });
		go.addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});
		row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
	}

	onClose() {
		this.contentEl.empty();
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
				'Last scan: ' +
				(scan ? timeAgo(scan.at) : 'never') +
				' · ' +
				ecosystemInfo(this.plugin.ecosystem).cloud +
				(this.plugin.settings.watchVault ? ' · watching' : ''),
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
				text:
					'Scan to check whether this vault is set up to sync across your devices through ' +
					transportName(this.plugin.ecosystem) +
					'.',
			});
			return;
		}

		this.renderLocation(root, scan);
		this.renderGithub(root, scan);
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
			const eco = ecosystemInfo(this.plugin.ecosystem);
			card.createEl('p', {
				cls: 'jemzsync-card-body',
				text:
					'No other devices seen yet. Enable jemzsync in this same vault on your ' +
					eco.otherDevice +
					' — each device announces itself through ' +
					transportName(this.plugin.ecosystem) +
					' and appears here on its own. The announcement travelling across is itself proof that sync is flowing.',
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

	/**
	 * The GitHub card. Absent entirely unless the vault is set to use it, so
	 * that anyone who never turns it on sees the panel they always saw.
	 */
	renderGithub(root, scan) {
		const cfg = this.plugin.github;
		if (!storageUsesGithub(cfg.mode)) return;

		const health = this.plugin.lastSyncError
			? {
					ok: false,
					title: 'GitHub sync is failing',
					detail: this.plugin.lastSyncError,
			  }
			: scan.githubHealth || classifyGithubHealth(cfg, Date.now());
		const card = root.createDiv({
			cls: 'jemzsync-card ' + (health.ok ? 'is-ok' : 'is-warn'),
		});
		card.createEl('div', { cls: 'jemzsync-card-title', text: health.title || 'GitHub' });
		if (health.detail) {
			card.createEl('p', { cls: 'jemzsync-card-body', text: health.detail });
		}

		if (!cfg.token || !cfg.repo) {
			card.createEl('p', {
				cls: 'jemzsync-card-body',
				text: 'Open Settings → jemzsync to finish setting this up.',
			});
			return;
		}

		if (this.plugin.pendingPlan) {
			card.createEl('div', {
				cls: 'jemzsync-compare is-warn',
				text:
					'Waiting for you: ' +
					describeSyncPlan(this.plugin.pendingPlan) +
					'. Nothing has been changed yet — press Sync now to review it.',
			});
		}

		const row = card.createDiv({ cls: 'jemzsync-actions' });
		const sync = row.createEl('button', { text: 'Sync now' });
		sync.addEventListener('click', async () => {
			sync.disabled = true;
			sync.setText('Checking…');
			try {
				let res = await this.plugin.syncWithGithub({
					onProgress: (n, total) => sync.setText('Sending ' + n + '/' + total + '…'),
				});

				// Anything destructive stops here and shows what it would do.
				if (!res.applied && res.reason === 'needs-confirmation') {
					new SyncConfirmModal(this.plugin.app, res.plan, cfg.repo, () => {
						this.plugin
							.syncWithGithub({ confirmed: true })
							.then((r) => {
								new Notice(r.applied ? describeSyncPlan(r.plan) + '.' : 'Nothing to do.');
								return this.plugin.runScan(false);
							})
							.then(() => this.render())
							.catch((e) => new Notice(String((e && e.message) || e)));
					}).open();
					return;
				}

				if (!res.applied && res.reason === 'in-sync') {
					new Notice('Already in sync with ' + cfg.repo + '.');
				} else if (res.applied) {
					new Notice(describeSyncPlan(res.plan) + '.');
					if (res.plan.conflict.length) {
						new Notice(
							res.plan.conflict.length +
								' file(s) were edited in both places. Both versions were kept — see the conflicts card.'
						);
					}
					await this.plugin.runScan(false);
				}
				this.render();
			} catch (err) {
				new Notice(String((err && err.message) || err));
			} finally {
				sync.disabled = false;
				sync.setText('Sync now');
			}
		});

		if (this.plugin.settings.githubAutoSync) {
			card.createEl('div', {
				cls: 'jemzsync-meta',
				text:
					'Sending automatically after edits · checking every ' +
					this.plugin.settings.githubPullMinutes +
					' min',
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
			const plan = buildMigrationPlan(
				basePath,
				this.plugin.app.vault.getName(),
				this.plugin.ecosystem
			);
			if (plan.shell) {
				const pre = card.createEl('pre', { cls: 'jemzsync-shell' });
				pre.createEl('code', { text: plan.shell });
				const copy = card.createEl('button', { text: 'Copy commands' });
				copy.addEventListener('click', async () => {
					await copyToClipboard(
						plan.shell,
						'Commands copied. Paste them into your terminal.'
					);
				});
			}
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
			await copyToClipboard(fp.digest, 'Fingerprint copied.');
		});

		const paired = this.plugin.pairing;
		if (paired.fingerprint) {
			/*
			 * This used to pass the *local* file count as the remote one, so a
			 * mismatch always reported "same file count, so some file differs
			 * in size" — usually untrue. Auto-fill records the real counts off
			 * the beacon, and a hand-typed digest has none, in which case the
			 * comparison stays honest by reporting only that they differ.
			 */
			const remote = { digest: paired.fingerprint, files: paired.files || 0 };
			const cmp = paired.files
				? compareFingerprints(remote, fp, transportName(this.plugin.ecosystem))
				: {
						match: remote.digest === fp.digest,
						summary:
							remote.digest === fp.digest
								? 'Match. That device holds the same files as this one.'
								: 'No match — the two devices are holding different files. Wait a few minutes for ' +
								  transportName(this.plugin.ecosystem) +
								  ', then scan again.',
				  };
			card.createEl('div', {
				cls: 'jemzsync-compare ' + (cmp.match ? 'is-ok' : 'is-warn'),
				text: (paired.label || 'Other device') + ': ' + cmp.summary,
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
		/*
		 * A `.icloud` stub is always iCloud's doing, so naming iCloud here is
		 * correct — but the device looking at it is not always a Mac. iCloud
		 * for Windows produces exactly these files, and that user was being
		 * told to open Finder.
		 */
		const eco = ecosystemInfo(this.plugin.ecosystem);
		card.createEl('p', {
			cls: 'jemzsync-card-body',
			text:
				'iCloud offloaded these to save space, so Obsidian cannot read them. In ' +
				eco.fileManager +
				', right-click the Obsidian folder in iCloud Drive and choose "Keep Downloaded".' +
				(this.plugin.ecosystem === 'apple'
					? ' On iPhone, open the vault folder in Files and pull down to download.'
					: ''),
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

		/*
		 * Deliberately neutral. CONFLICT_PATTERNS also matches Dropbox's
		 * "conflicted copy" and Syncthing's .sync-conflict- markers, so this
		 * card fires for providers that have nothing to do with iCloud — and
		 * naming the ecosystem's cloud instead would be just as wrong for a
		 * Windows user whose vault is in Dropbox.
		 */
		if (!scan.conflicts.length) {
			card.createEl('p', {
				cls: 'jemzsync-card-body',
				text: 'No duplicate copies have been left behind.',
			});
			return;
		}

		card.createEl('p', {
			cls: 'jemzsync-card-body',
			text: 'A sync engine makes a second copy when two devices edit a note before seeing each other. Pick which version survives.',
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

		/*
		 * Where the vault lives comes first. It is the choice that decides
		 * what every other setting here even means — and it was previously
		 * below eight toggles, where nobody would find it.
		 */
		this.displayStorage(containerEl);

		containerEl.createEl('h3', { text: 'Devices and scanning' });

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
						const chosen = v.trim();
						this.plugin.identity.name = chosen || defaultDeviceName();
						// Emptying the field hands naming back to the plugin,
						// which will then keep it distinct from the others.
						this.plugin.identity.named = !!chosen;
						saveDeviceName(this.plugin.app, chosen);
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
			.setName('Watch the vault while Obsidian runs')
			.setDesc(
				'Rescan a few seconds after anything changes, including files arriving from the cloud, instead of waiting for the next scheduled scan. Takes effect after Obsidian restarts.'
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.watchVault).onChange(async (v) => {
					this.plugin.settings.watchVault = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Warn when the vault cannot sync')
			.setDesc(
				'Show a popup if this vault is somewhere ' +
					ecosystemInfo(this.plugin.ecosystem).cloud +
					' cannot reach.'
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.warnOnBadLocation).onChange(async (v) => {
					this.plugin.settings.warnOnBadLocation = v;
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

		this.displayPairing(containerEl);
	}

	/**
	 * Where the vault is kept.
	 *
	 * Presented as one choice with plain descriptions rather than a pile of
	 * toggles, because the three options genuinely are alternatives and the
	 * consequence of each is what matters.
	 */
	displayStorage(containerEl) {
		const cfg = this.plugin.github;
		const eco = ecosystemInfo(this.plugin.ecosystem);

		containerEl.createEl('h3', { text: 'Where this vault is stored' });

		const current = STORAGE_MODES.filter((m) => m.id === cfg.mode)[0] || STORAGE_MODES[0];
		containerEl.createEl('p', { cls: 'jemzsync-card-body', text: current.blurb(eco) });

		new Setting(containerEl)
			.setName('Storage')
			.setDesc(
				'Your devices are on ' +
					eco.label +
					', so the cloud here means ' +
					eco.cloud +
					'. Choose GitHub if your devices are not all in the same ecosystem.'
			)
			.addDropdown((d) => {
				for (let i = 0; i < STORAGE_MODES.length; i++) {
					d.addOption(STORAGE_MODES[i].id, STORAGE_MODES[i].label(eco));
				}
				d.setValue(cfg.mode).onChange(async (v) => {
					cfg.mode = v;
					saveGithubConfig(this.plugin.app, cfg);
					await this.plugin.runScan(false);
					this.display();
				});
			});

		if (!storageUsesGithub(cfg.mode)) return;

		/* ---- GitHub account ---- */

		if (!cfg.token) {
			new Setting(containerEl)
				.setName('GitHub access token')
				.setDesc(
					'A fine-grained personal access token with Contents: read and write on the repository you want to use. GitHub\'s API authenticates with a token, not an SSH key — SSH is for the git command line, which a plugin cannot run on a phone. The token is kept on this device only: never in the vault, and never in the repository.'
				)
				.addText((t) => {
					/*
					 * Masked by default, with an eye to reveal. A credential
					 * typed in a settings pane is visible to anyone standing
					 * behind you and to any screen recording, so hiding it is
					 * the default and showing it is the deliberate act.
					 */
					t.setPlaceholder('github_pat_…').onChange((v) => {
						this.pendingToken = v.trim();
					});
					if (t.inputEl) {
						t.inputEl.type = 'password';
						this.pendingTokenEl = t.inputEl;
					}
				})
				.addExtraButton((b) =>
					b
						.setIcon('eye')
						.setTooltip('Show the token')
						.onClick(() => {
							const el = this.pendingTokenEl;
							if (!el) return;
							el.type = el.type === 'password' ? 'text' : 'password';
						})
				)
				.addExtraButton((b) =>
					b
						.setIcon('info')
						.setTooltip('How to create a token, and which permissions it needs')
						.onClick(() => new HelpModal(this.app, 'token').open())
				)
				.addButton((b) =>
					b.setButtonText('Connect').onClick(async () => {
						try {
							const me = await this.plugin.connectGithub(this.pendingToken || '');
							new Notice('Connected to GitHub as ' + me.login + '.');
							this.pendingToken = '';
							this.display();
						} catch (err) {
							new Notice(String((err && err.message) || err));
						}
					})
				);

			return;
		}

		new Setting(containerEl)
			.setName('GitHub account')
			.setDesc('Connected as ' + cfg.login + ' · token ' + maskToken(cfg.token))
			.addButton((b) =>
				b.setButtonText('Disconnect').onClick(() => {
					this.plugin.disconnectGithub();
					new Notice('Disconnected. The token has been removed from this device.');
					this.display();
				})
			);

		/* ---- repository ---- */

		new Setting(containerEl)
			.setName('Repository')
			.setDesc(
				cfg.repo
					? 'The vault is saved into ' + cfg.repo + '. Every device must point at this same repository.'
					: 'Not chosen yet. Private repositories are listed too.'
			)
			.addText((t) =>
				t
					.setPlaceholder('owner/repo')
					.setValue(cfg.repo)
					.onChange((v) => {
						const ref = parseRepoRef(v);
						cfg.repo = ref ? ref.full : '';
						saveGithubConfig(this.plugin.app, cfg);
					})
			)
			.addButton((b) =>
				b.setButtonText('Choose…').onClick(async () => {
					try {
						const client = this.plugin.githubClient();
						const repos = await client.listRepos();
						new RepoPickerModal(this.app, repos, (chosen) => {
							cfg.repo = chosen.full;
							cfg.branch = chosen.defaultBranch || 'main';
							saveGithubConfig(this.plugin.app, cfg);
							this.display();
						}).open();
					} catch (err) {
						new Notice(String((err && err.message) || err));
					}
				})
			);

		new Setting(containerEl)
			.setName('Branch')
			.setDesc('Which branch the vault is committed to.')
			.addText((t) =>
				t
					.setPlaceholder('main')
					.setValue(cfg.branch)
					.onChange((v) => {
						cfg.branch = v.trim() || 'main';
						saveGithubConfig(this.plugin.app, cfg);
					})
			);

		new Setting(containerEl)
			.setName('Keep in sync automatically')
			.setDesc(
				'Send changes a few seconds after you stop typing, and check for other devices\' work on a timer. GitHub cannot notify a plugin when something changes, so receiving is a poll rather than a push.'
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.githubAutoSync).onChange(async (v) => {
					this.plugin.settings.githubAutoSync = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Check GitHub every')
			.setDesc('Minutes between checks for changes made on your other devices.')
			.addText((t) =>
				t
					.setPlaceholder('5')
					.setValue(String(this.plugin.settings.githubPullMinutes))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.githubPullMinutes = isNaN(n) ? 5 : Math.max(1, n);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Notes only')
			.setDesc(
				'Leave off to include your Obsidian configuration — themes, snippets and plugins — so a new device comes up already set up. Other plugins\' data.json files are never sent either way, because they can hold API keys.'
			)
			.addToggle((t) =>
				t.setValue(cfg.notesOnly).onChange((v) => {
					cfg.notesOnly = v;
					saveGithubConfig(this.plugin.app, cfg);
				})
			);
	}

	/**
	 * The two paired-device fields.
	 *
	 * Both fill themselves in from the beacons your other devices write, and
	 * both stay editable at all times — nothing here is ever disabled. Typing
	 * in a field claims it; clearing a field hands it back to the plugin.
	 */
	displayPairing(containerEl) {
		const eco = ecosystemInfo(this.plugin.ecosystem);
		const p = this.plugin.pairing;

		const sourceNote = (source) =>
			source === 'auto'
				? ' Filled in automatically — edit it and it stays as you leave it.'
				: source === 'manual'
				? ' You set this. Clear the field to let jemzsync fill it in again.'
				: '';

		new Setting(containerEl)
			.setName('Other device fingerprint')
			.setDesc(
				'Detected automatically once another device running jemzsync appears in this vault. You can also paste one in from your ' +
					eco.otherDevice +
					'.' +
					sourceNote(p.fingerprintSource)
			)
			.addText((t) =>
				t
					.setPlaceholder('a1b2c3d4-e5f6a7b8')
					.setValue(p.fingerprint)
					.onChange((v) => this.setPaired('fingerprint', v))
			)
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('Detect again')
					.onClick(() => this.redetectPairing())
			)
			.addExtraButton((b) =>
				b
					.setIcon('info')
					.setTooltip('How to get a fingerprint from another device')
					.onClick(() => new HelpModal(this.app, 'fingerprint').open())
			);

		new Setting(containerEl)
			.setName('Other device name')
			.setDesc(
				'A label so you remember which device that fingerprint came from.' +
					sourceNote(p.labelSource)
			)
			.addText((t) =>
				t
					.setPlaceholder(eco.deviceExample)
					.setValue(p.label)
					.onChange((v) => this.setPaired('label', v))
			)
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('Detect again')
					.onClick(() => this.redetectPairing())
			);
	}

	/**
	 * Record a hand-edited pairing field.
	 *
	 * Emptying a field resets its provenance rather than marking it manual, so
	 * that clearing it is how you ask for auto-fill back.
	 */
	setPaired(which, raw) {
		const value = String(raw || '').trim();
		const p = this.plugin.pairing;
		p[which] = value;
		p[which + 'Source'] = value ? 'manual' : '';
		if (which === 'fingerprint') {
			// A digest typed by hand carries no file counts, and inventing
			// them is what made the panel claim two differing vaults held the
			// same number of files.
			p.files = 0;
			p.bytes = 0;
		}
		savePairing(this.plugin.app, p);
		this.plugin.refreshViews();
	}

	/** Hand both fields back to the plugin and re-run detection now. */
	async redetectPairing() {
		this.plugin.pairing = {
			fingerprint: '',
			fingerprintSource: '',
			label: '',
			labelSource: '',
			files: 0,
			bytes: 0,
		};
		savePairing(this.plugin.app, this.plugin.pairing);
		await this.plugin.runScan(false);
		this.display();
		new Notice(
			this.plugin.pairing.fingerprint
				? 'Paired with ' + (this.plugin.pairing.label || 'your other device') + '.'
				: 'No other device has announced itself in this vault yet.'
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
/*
 * Per-device state, exposed for tests. These reach storage only through the
 * `app` handed to them, so a fake app exercises them the same way the fake
 * adapter exercises the scanner.
 */
module.exports.__device = {
	loadDeviceIdentity: loadDeviceIdentity,
	saveDeviceName: saveDeviceName,
	loadDismissedWarning: loadDismissedWarning,
	saveDismissedWarning: saveDismissedWarning,
	loadPairing: loadPairing,
	savePairing: savePairing,
	applyPairingAutofill: applyPairingAutofill,
	loadGithubConfig: loadGithubConfig,
	saveGithubConfig: saveGithubConfig,
	classifyGithubHealth: classifyGithubHealth,
	loadSyncBase: loadSyncBase,
	saveSyncBase: saveSyncBase,
	maskToken: maskToken,
	GITHUB_KEYS: GITHUB_KEYS,
};

/*
 * The GitHub client and push engine. Both take their transport as an
 * argument, so the tests drive them with an in-memory GitHub exactly as the
 * scanner is driven by a fake adapter — the suite never touches the network.
 */
module.exports.__github = {
	githubClient: githubClient,
	trashPath: trashPath,
	assertScanComplete: assertScanComplete,
	unreadableFromScan: unreadableFromScan,
	githubSync: githubSync,
	collectPushable: collectPushable,
	storageUsesGithub: storageUsesGithub,
	storageUsesCloud: storageUsesCloud,
	STORAGE_ECOSYSTEM: STORAGE_ECOSYSTEM,
	STORAGE_GITHUB: STORAGE_GITHUB,
	STORAGE_BOTH: STORAGE_BOTH,
	STORAGE_MODES: STORAGE_MODES,
};
/*
 * The panel and the settings tab, exposed for the same reason as the two
 * above: so they can be driven by a test. Rendering them against a stand-in
 * for Obsidian is the only way to catch a wrong API call or a hardcoded
 * string without opening the app on five different machines.
 */
module.exports.__ui = {
	JemzSyncView: JemzSyncView,
	JemzSyncSettingTab: JemzSyncSettingTab,
	SetupModal: SetupModal,
	HelpModal: HelpModal,
	HELP_TOPICS: HELP_TOPICS,
};
module.exports.VIEW_TYPE_JEMZSYNC = VIEW_TYPE_JEMZSYNC;
module.exports.PLUGIN_ID = PLUGIN_ID;
