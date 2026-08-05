#!/usr/bin/env node
'use strict';

/*
 * Builds `main.js` from `src/main.js`.
 *
 * Why this exists:
 *   Obsidian's automated review reproduces a release from source and compares
 *   the result against the published asset. Without a `build` script in
 *   package.json it cannot run that check, and the whole scorecard section
 *   degrades — build verification, the malware scan, the obfuscation scan and
 *   the network-request scan all report "not available", and the release is
 *   flagged as unverifiable.
 *
 * What it does:
 *   Compiles `src/main.js` to catch a syntax error before it can ship, stamps
 *   the plugin id and version from manifest.json onto the front, and writes
 *   `main.js`. There is still no compiler and no bundler — the authored file
 *   is plain JavaScript that Obsidian loads directly, which is why the same
 *   output runs unchanged on iPhone and iPad.
 *
 * Determinism:
 *   The output is a pure function of `src/main.js` and manifest.json. No
 *   timestamps, no build host, no ordering that depends on the filesystem —
 *   anyone checking out this commit and running `npm run build` gets a
 *   byte-identical `main.js`. That is the property the review depends on, so
 *   never put a date or a random value in the banner.
 *
 * Usage:
 *   node build.js            write main.js
 *   node build.js --check    verify the committed main.js is what src/ produces
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src', 'main.js');
const OUT = path.join(ROOT, 'main.js');
const MANIFEST = path.join(ROOT, 'manifest.json');

function build() {
	const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
	const source = fs.readFileSync(SRC, 'utf8');

	// Compile-only. This never runs the plugin — it just refuses to emit a
	// main.js that Obsidian would fail to parse on load.
	new vm.Script(source, { filename: 'src/main.js' });

	const banner =
		'/* ' + manifest.id + ' ' + manifest.version +
		' — generated from src/main.js by build.js. Edit the source, not this file. */\n';

	return banner + source;
}

const built = build();

if (process.argv.includes('--check')) {
	const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
	if (current !== built) {
		console.error(
			'main.js does not match what src/main.js builds.\n' +
			'Run `npm run build` and commit the result.'
		);
		process.exit(1);
	}
	console.log('main.js matches src/main.js (' + Buffer.byteLength(built) + ' bytes)');
} else {
	fs.writeFileSync(OUT, built);
	console.log('built main.js (' + Buffer.byteLength(built) + ' bytes)');
}
