#!/usr/bin/env node
// Stub: ArgyllCMS spotread with no instrument connected. Stays alive (like the
// real tool waiting) but prints the not-found error — the app must classify
// this as no-probe, not ready.
process.stdout.write('spotread: Verbose mode\n');
process.stdout.write('spotread: Error - No instruments found!\n');
setInterval(() => {}, 1000); // don't exit; force detection to rely on the error line
