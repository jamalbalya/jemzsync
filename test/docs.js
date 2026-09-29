'use strict';

/*
 * Documentation consistency check.
 *
 *   npm run test:docs
 *
 * Why this exists:
 *   Every factual claim in this file was, at some point, wrong in the README.
 *   A command was renamed and the table still listed the old name; a feature
 *   moved in 2.0.1 and the prose said 1.4.0; the test count sat at 327 while
 *   the suite grew past 400. None of that is caught by running the tests,
 *   because the tests do not read the README — so the documentation drifted
 *   quietly, and "false information" is the one defect a user cannot see past.
 *
 *   These are the claims that can be checked mechanically. Anything the README
 *   asserts about counts, names or versions is derived from the code here
 *   rather than trusted, so it can only be wrong for as long as CI is red.
 *
 * Deliberately cheap: it runs the fast suite once and reads the mutation list
 * statically, so it costs under a second rather than repeating a 60-second
 * mutation run.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'versions.json'), 'utf8'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
	try {
		fn();
		passed++;
		console.log('  ok   ' + name);
	} catch (err) {
		failed++;
		failures.push([name, err]);
		console.log('  FAIL ' + name);
	}
}

console.log('jemzsync documentation check\n');

/* ---------------------- counts the README quotes ---------------------- */

check('the README states the real number of tests', () => {
	const out = execSync(process.execPath + ' test/test-core.js', {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	});
	const m = out.match(/(\d+) passed, (\d+) failed/);
	assert.ok(m, 'could not read the suite total');
	assert.strictEqual(m[2], '0', 'the suite itself is failing');

	const claimed = README.match(/(\d[\d,]*) tests and zero dependencies/);
	assert.ok(claimed, 'the README no longer states a test count in the expected form');
	assert.strictEqual(
		claimed[1].replace(/,/g, ''),
		m[1],
		'README says ' + claimed[1] + ' tests, the suite runs ' + m[1]
	);
});

check('the README states the real number of mutations', () => {
	const total = require('./mutations.js').length;
	const claimed = README.match(
		/(\d+) deliberate regressions are injected into a temporary copy of the source and all (\d+) must be caught/
	);
	assert.ok(claimed, 'the README no longer states a mutation count in the expected form');
	assert.strictEqual(
		Number(claimed[1]),
		total,
		'README says ' + claimed[1] + ' mutations, test/mutations.js holds ' + total
	);
	assert.strictEqual(
		claimed[1],
		claimed[2],
		'the two numbers in that sentence disagree with each other'
	);
});

/* ---------------------- names the README quotes ---------------------- */

/**
 * Every command the plugin registers, read off `addCommand` in the source.
 *
 * The README's Commands table is what someone searches the palette for, so a
 * renamed command with a stale table sends them looking for something that is
 * not there — which is exactly what happened when "Check iCloud setup" became
 * "Check sync setup".
 */
function registeredCommands() {
	const names = [];
	const re = /addCommand\(\{[\s\S]*?\bname:\s*'((?:[^'\\]|\\.)*)'/g;
	let m;
	while ((m = re.exec(SRC))) names.push(m[1].replace(/\\'/g, "'"));
	return names;
}

check('every command the plugin registers is in the README table', () => {
	const commands = registeredCommands();
	assert.ok(commands.length >= 5, 'expected to find the commands, found ' + commands.length);
	const missing = commands.filter((n) => README.indexOf('| ' + n + ' |') === -1);
	assert.deepStrictEqual(
		missing,
		[],
		'these commands are registered but absent from the README Commands table: ' +
			missing.join(', ')
	);
});

check('the README lists no command the plugin does not register', () => {
	const commands = registeredCommands();
	/* The rows between the Commands heading and the next horizontal rule. */
	const section = README.split('## Commands')[1].split('\n---')[0];
	const rows = section
		.split('\n')
		.filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l))
		.map((l) => l.split('|')[1].trim())
		.filter((c) => c && c !== 'Command');
	const unknown = rows.filter((r) => commands.indexOf(r) === -1);
	assert.deepStrictEqual(
		unknown,
		[],
		'the README names commands that do not exist: ' + unknown.join(', ')
	);
});

/* ---------------------- versions ---------------------- */

check('manifest and package agree on the version', () => {
	assert.strictEqual(manifest.version, pkg.version);
});

check('versions.json carries this version and the right minimum', () => {
	assert.strictEqual(
		versions[manifest.version],
		manifest.minAppVersion,
		'versions.json must map ' + manifest.version + ' to ' + manifest.minAppVersion
	);
});

check('the README only cites versions that were actually released', () => {
	/*
	 * A feature attributed to a version that never existed is worse than no
	 * attribution: someone checking their own install against it can never
	 * make the two agree. "moved out of saveData in 1.4.0" named the
	 * minAppVersion by mistake; the change shipped in 2.0.1.
	 */
	const known = Object.keys(versions);
	const cited = README.match(/\bin (\d+\.\d+\.\d+)\b/g) || [];
	const unknown = cited
		.map((c) => c.slice(3))
		.filter((v) => known.indexOf(v) === -1);
	assert.deepStrictEqual(
		unknown,
		[],
		'the README cites versions that were never released: ' + unknown.join(', ')
	);
});

/* ---------------------- claims about what never leaves ---------------------- */

check('every path the README promises is never pushed really is excluded', () => {
	/*
	 * The privacy section is the most load-bearing prose in the project. Each
	 * promise here is checked against the actual rule rather than taken on
	 * trust, using a path that rule is supposed to stop.
	 */
	const core = require('../main.js').__core;
	const promised = [
		'.obsidian/plugins/dataview/data.json',
		'.obsidian/workspace.json',
		'.obsidian/plugins/jemzsync/main.js',
		'.jemzsync/device-abc.json',
		'.trash/gone.md',
		'.git/config',
		'Notes/.DS_Store',
	];
	for (let i = 0; i < promised.length; i++) {
		const verdict = core.shouldPushPath(promised[i], 10, {});
		assert.strictEqual(
			verdict.ok,
			false,
			promised[i] + ' is promised as never sent, but would be pushed'
		);
	}
});

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
