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
		"\t\t'.obsidian/workspace',\n\t\t'.trash/',\n\t\t'.git/',\n\t\t'.jemzsync/',\n\t\tSELF_DIR,",
		''],
	['the plugin counts its own files (an upgrade looks like a sync failure)',
		"\t\tif (e.path.indexOf(SELF_DIR) === 0) continue;",
		''],
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
	['iCloud on Windows reported as local-only (denies it is syncing at all)',
		"if (cloud && cloud.id === 'icloud') {",
		'if (0) {'],
	['iCloud folder no longer recognised outside Apple',
		"{ id: 'icloud', label: 'iCloud Drive', re: /(^|\\/)iCloud ?Drive(\\/|$)/i },",
		"{ id: 'icloud', label: 'iCloud Drive', re: /zzz-never-matches/ },"],
	['iOS sandbox path falls through to local-only (tells a working vault to move)',
		"if (platform === 'mobile') {\n\t\treturn appleMobileUnverifiable(vaultName);\n\t}\n\n\treturn {\n\t\tcode: 'local-only',",
		"if (0) {\n\t\treturn appleMobileUnverifiable(vaultName);\n\t}\n\n\treturn {\n\t\tcode: 'local-only',"],
	['Android sandbox path falls through to local-only',
		"if (!cloud && ctx.platform === 'mobile') {",
		'if (0) {'],
	['Windows migration deletes the original instead of copying',
		'\'Copy-Item -Recurse "\' + src + \'" "\' + target + \'"\',',
		'\'Remove-Item -Recurse "\' + src + \'"\','],

	/* --- pairing auto-fill (1.4.0) --- */

	['auto-fill overwrites a value the user typed',
		"if (source === 'manual' && cur) {",
		'if (false) {'],
	['a cleared field is no longer refilled ("if still empty, help me")',
		"if (!cur) return { value: det, source: 'auto', changed: cur !== det };",
		"if (!cur && source !== 'manual') return { value: det, source: 'auto', changed: cur !== det };"],
	['a value from before auto-fill existed is treated as auto and overwritten',
		"\t// Claim it as manual so it is protected from here on.\n\treturn { value: cur, source: 'manual', changed: true };",
		"\t// Claim it as manual so it is protected from here on.\n\treturn { value: det, source: 'auto', changed: true };"],
	['a future timestamp counts as fresh (a skewed clock hijacks the pairing)',
		'Math.abs(now - (b.updatedAt || 0)) <= staleMs',
		'now - (b.updatedAt || 0) <= staleMs'],
	['a hand-typed digest is given file counts it never had',
		'\t\tnext.files = 0;\n\t\tnext.bytes = 0;',
		'\t\tnext.files = picked.fingerprint.files || 0;\n\t\tnext.bytes = picked.fingerprint.bytes || 0;'],
	['the synced setting outranks per-device storage (the ping-pong returns)',
		'if (!fingerprint && settings.pairedFingerprint) {',
		'if (settings.pairedFingerprint) {'],
	['the pairing is written somewhere that is not per-device storage',
		"writeLocal(app, PAIRED_KEYS.fingerprint, pairing.fingerprint || '');",
		"writeLocal(app, 'jemzsync-settings-blob', JSON.stringify(pairing));"],

	/* --- device naming (1.4.0) --- */

	['a beacon from a dead install still holds a claim to its name',
		'if (Math.abs(now - (b.updatedAt || 0)) <= staleMs) out.push(b);',
		'out.push(b);'],
	['both colliding devices rename at once and collide again',
		"if (!selfId || String(o.id || '') < String(selfId)) contested = true;",
		'contested = true;'],
	['an Android phone announces itself as an iPhone again',
		"if (flags.isIosApp) return flags.isTablet ? 'iPad' : 'iPhone';",
		"if (flags.isPhone) return 'iPhone';"],

	/* --- ecosystem-neutral language (1.4.0) --- */

	['storage labels hardcoded to one ecosystem again',
		"\t\tlabel: (eco) => \"This device's \" + eco.cloud + ' only',",
		'\t\tlabel: () => "This device\'s iCloud Drive only",'],
	['Apple wording hardcoded back into a shared settings field',
		'.setPlaceholder(eco.deviceExample)',
		".setPlaceholder('iPhone')"],
	['Windows users are sent to Finder again',
		"fileManager: 'File Explorer',",
		"fileManager: 'Finder',"],
	['the default comparison wording names iCloud on every platform',
		"(transport || 'your sync')",
		"(transport || 'iCloud')"],
	['GitHub storage still reports the ecosystem cloud as the transport',
		"if (storageMode === 'github') return 'GitHub';",
		'if (false) return \'GitHub\';'],

	/* --- GitHub storage (2.0.0) --- */

	['the branch is force-pushed (silently erases another device)',
		"\t\t\tawait call('PATCH', '/repos/' + repo + '/git/refs/heads/' + encodeURIComponent(branch), {\n\t\t\t\tsha: sha,\n\t\t\t});",
		"\t\t\tawait call('PATCH', '/repos/' + repo + '/git/refs/heads/' + encodeURIComponent(branch), {\n\t\t\t\tsha: sha,\n\t\t\t\tforce: true,\n\t\t\t});"],
	['a truncated tree is ignored (push would delete the unlisted files)',
		'\t\t\tif (r.json.truncated) {',
		'\t\t\tif (false) {'],
	['the plugin starts syncing its own code again (self-update, policy breach)',
		"\t{ re: /^\\.obsidian\\/plugins\\/jemzsync\\//, why: 'the plugin does not sync itself' },",
		''],
	["another plugin's data.json becomes pushable (secrets to a git repo)",
		"\t{ re: /^\\.obsidian\\/plugins\\/[^/]+\\/data\\.json$/, why: 'may contain another plugin\\'s secrets' },",
		''],
	['the access token is written outside per-device storage',
		"\twriteLocal(app, GITHUB_KEYS.token, cfg.token || '');",
		"\twriteLocal(app, 'leaked-token-key', cfg.token || '');"],
	['overwrites and deletions stop counting as destructive (no confirmation)',
		'\treturn !!plan && (plan.remove.length > 0 || plan.update.length > 0);',
		'\treturn false;'],
	['the blob-sha diff is abandoned and every file re-uploads',
		'\t\telse if (at !== f.sha) plan.update.push(f);\n\t\telse plan.unchanged++;',
		'\t\telse plan.update.push(f);'],
	['a bad token is retried instead of reported',
		'\treturn status === 403 || status === 409 || status === 429 || status >= 500;',
		'\treturn true;'],
	['GitHub-only mode still nags that the vault is not in iCloud',
		'\tif (ctx.storageMode === STORAGE_GITHUB) {',
		'\tif (false) {'],
	['an in-sync device forgets the agreement (next edit becomes a false conflict)',
		'\t\tif (!opts.dryRun) {\n\t\t\tawait io.saveBase(Object.assign(Object.create(null), remote), headSha);\n\t\t}',
		''],
	['an edit made during a sync is dropped instead of remembered',
		'\t\t\tthis.syncWanted = true;\n\t\t\treturn;',
		'\t\t\treturn;'],
	['an offloaded (.icloud) file is treated as deleted and removed from the repo',
		'\tconst list = (scan && scan.placeholders) || [];',
		'\tconst list = [];'],
	['a truncated vault scan is synced anyway (mass deletion)',
		'\tif (scan && scan.truncated) {',
		'\tif (false) {'],
	['the storage mode stops being consulted before syncing to GitHub',
		'\t\t\tstorageUsesGithub(this.github.mode) &&',
		''],
	['the safety pause is bypassed (destructive syncs apply silently)',
		"\tif (!opts.confirmed && syncPlanIsDestructive(plan)) {",
		'\tif (false) {'],
	['the bulk-deletion backstop is removed',
		'\tif (!opts.confirmedBulkDelete && remoteCount >= 4 && removing > remoteCount / 2) {',
		'\tif (false) {'],
	['a stale tree read is trusted, deleting files that were just pushed',
		'\t\tif (missing.length) {',
		'\t\tif (false) {'],
	['a delete falls back to a hard remove instead of the trash',
		"\t\tawait adapter.rename(path, '.trash/' + splitPath(path).base);\n\t\treturn 'vault-trash';",
		'\t\tawait adapter.remove(path);\n\t\treturn \'removed\';'],
	['an unreadable file is treated as deleted (removed from the repo)',
		'\t\t\terrors.push({ path: e.path, message: String((err && err.message) || err) });',
		'\t\t\t/* swallowed */'],

	/* --- two-way sync: the merge rules where data is lost (2.0.0) --- */

	['a conflict silently overwrites the local file instead of keeping both',
		'\t\t\t\tplan.conflict.push({ path: path, localSha: L, remoteSha: R });',
		'\t\t\t\tplan.pull.push({ path: path, sha: R });'],
	['an edit here loses to a delete elsewhere',
		'\t\t\t} else if (L && !R) {\n\t\t\t\tplan.push.push({ path: path, sha: L, note: \'kept: edited here, deleted there\' });',
		'\t\t\t} else if (L && !R) {\n\t\t\t\tplan.deleteLocal.push({ path: path });'],
	['an edit elsewhere loses to a delete here',
		'\t\t\t} else if (R && !L) {\n\t\t\t\tplan.pull.push({ path: path, sha: R, note: \'kept: edited there, deleted here\' });',
		'\t\t\t} else if (R && !L) {\n\t\t\t\tplan.deleteRemote.push({ path: path });'],
	['a remote deletion destroys the local file instead of trashing it',
		'\t\tawait io.trash(plan.deleteLocal[i].path);',
		'\t\tawait io.writeBytes(plan.deleteLocal[i].path, new Uint8Array(0));'],
	['an unreadable file is dropped from the local view (sync deletes it)',
		'\t\tif (io.base[p]) local[p] = io.base[p];',
		'\t\tif (false) local[p] = io.base[p];'],
	['the sync feedback loop is reopened (our own writes trigger another sync)',
		'\t\t\tif (!this.applyingRemote) this.scheduleGithubSync();',
		'\t\t\tthis.scheduleGithubSync();'],
	['the debounce guard on applying remote changes is removed',
		'\t\tif (this.applyingRemote || this.syncing) {\n\t\t\tthis.syncWanted = true;\n\t\t\treturn;\n\t\t}',
		''],

	/* --- the check schedule (2.1.0) --- */

	['every month is 30 days long (February and leap years wrong)',
		'\treturn new Date(year, month + 1, 0).getDate();',
		'\treturn 30;'],
	['the calendar starts the week on Sunday (grid shifted by a day)',
		'\treturn (date.getDay() + 6) % 7;',
		'\treturn date.getDay();'],
	['the month grid loses its sixth row (a long month is cut off)',
		'\tfor (let row = 0; row < 6; row++) {',
		'\tfor (let row = 0; row < 5; row++) {'],
	['a monthly repeat is worn down by short months (the 31st never returns)',
		'\tconst day = Math.min(date.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));',
		'\tconst day = date.getDate();'],
	['an impossible date is accepted (31 February silently becomes 3 March)',
		'\tif (day < 1 || day > daysInMonth(year, month)) return null;',
		'\tif (false) return null;'],
	['a date is parsed as UTC, shifting every appointment by the time-zone offset',
		'\tconst d = new Date(year, month, day, hour, minute, 0, 0);',
		"\tconst d = new Date(text + ':00.000Z');"],
	['a repeat can return the occurrence it has already run (schedule stalls)',
		'\t\tif (t > after) return t;',
		'\t\tif (t >= after) return t;'],
	['the count is no longer clamped to its unit\'s range',
		'\tif (spec.max && every > spec.max) every = spec.max;',
		'\t/* unclamped */'],
	['the old "check every N minutes" setting is discarded on upgrade',
		'\tconst legacy = Math.floor(Number(settings.githubPullMinutes));',
		'\tconst legacy = NaN;'],
	['a vault that has never been checked waits a whole period first',
		'\t\tif (!lastRun) return now;',
		'\t\tif (!lastRun) return now + period;'],
	['the setTimeout cap is removed (a monthly schedule overflows and spins)',
		'\t\tlet wait = Math.max(0, Math.min(next - now, CHECK_TICK_MAX_MS));',
		'\t\tlet wait = Math.max(0, next - now);'],
	['a failed check is not stamped (a broken token is retried every tick)',
		'\t\t\tthis.lastCheckAt = now;',
		'\t\t\tthis.lastCheckAt = this.lastCheckAt;'],
	['a due check with nothing connected re-arms with no delay (busy loop)',
		'\t\t\tthis.armCheckTimer(check ? 0 : due ? CHECK_IDLE_MS : 0);',
		'\t\t\tthis.armCheckTimer(0);'],
	['the timer outlives the plugin being disabled',
		'\trunScheduledCheck() {\n\t\tif (this.unloaded) return;',
		'\trunScheduledCheck() {'],
	['a schedule change no longer re-arms the timer (needs a restart)',
		'\t\tthis.armCheckTimer();\n\t\tthis.refreshViews();',
		'\t\tthis.refreshViews();'],
	['switching automatic syncing off no longer stops the checks',
		'\t\tconst check = due && this.githubReady() && this.settings.githubAutoSync;',
		'\t\tconst check = due && this.githubReady();'],

	/* --- what the adversarial review of 2.1.0 turned up --- */

	['the re-arm stops being unconditional (finally weakened to catch)',
		'\t\t} finally {\n\t\t\tthis.armCheckTimer(check ? 0 : due ? CHECK_IDLE_MS : 0);\n\t\t}',
		'\t\t} catch (_) {\n\t\t\tthis.armCheckTimer(check ? 0 : due ? CHECK_IDLE_MS : 0);\n\t\t}'],
	['a throwing panel stops the schedule (refreshViews left unguarded)',
		'\t\t\ttry {\n\t\t\t\tthis.refreshViews();\n\t\t\t} catch (_) {\n\t\t\t\t/* a torn-down panel is not a reason to stop checking */\n\t\t\t}',
		'\t\t\tthis.refreshViews();'],
	['a clock that ran fast parks the schedule for the whole skew',
		'\tif (lastRun > now) lastRun = 0;',
		'\t/* a future stamp is trusted */'],
	['a bad stamp is clamped rather than discarded, so it never repairs itself',
		'\tif (lastRun > now) lastRun = 0;',
		'\tif (lastRun > now) lastRun = now;'],
	['the check stamp goes back into the vault-synced settings',
		'\tconst n = Number(readLocal(app, LAST_CHECK_KEY));',
		'\tconst n = NaN;'],
	['a vault not using GitHub still wakes a timer for ever',
		'\t\tif (!storageUsesGithub(this.github.mode)) return;',
		'\t\tif (false) return;'],
	['a two-digit year is silently read as the 1900s',
		'\tif (year < 1970 || year > 9999) return null;',
		'\tif (false) return null;'],
	['the picker accepts a moment that has already passed',
		'\t\t\tif (this.selected.getTime() <= Date.now()) return;',
		'\t\t\tif (false) return;'],
	['calendar days are keyed by midnight, which some zones skip',
		'\t\t\tconst cellDate = new Date(year, month, 1 + offset, 12, 0, 0, 0);',
		'\t\t\tconst cellDate = new Date(year, month, 1 + offset);'],
	['a saved-but-empty schedule discards the old minutes setting',
		'\t\tthis.settings.githubSchedule = scheduleFromSettings(saved || {});',
		'\t\tthis.settings.githubSchedule = normalizeSchedule((saved || {}).githubSchedule);'],
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
