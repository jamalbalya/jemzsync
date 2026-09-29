'use strict';

/*
 * Mutation testing for the jemzsync test suite.
 *
 *   npm run test:mutation
 *
 * Verifies the suite is worth trusting: each entry in test/mutations.js
 * injects a known bug into a temporary copy of main.js and asserts the suite
 * fails. A mutation that survives means a class of regression the tests would
 * let through.
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

const mutations = require('./mutations.js');

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
