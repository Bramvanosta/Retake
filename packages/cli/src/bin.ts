#!/usr/bin/env node
// Every Node.js must be able to read this file far enough to say which version it needs: no import / export /
// import.meta / top-level await and nothing newer than ES2017 here (Node.js 10 stops at those with a bare
// SyntaxError). The CLI itself is loaded with a dynamic import built at run time, once the version is known to fit.
const MIN_NODE = 22;
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < MIN_NODE) {
  process.stderr.write(
    `studio needs Node.js ${MIN_NODE} or later; this is v${process.versions.node} (${process.execPath}).\n` +
      `Install Node.js ${MIN_NODE}+ (nvm install ${MIN_NODE}, brew install node@${MIN_NODE}…) or put it first on PATH; ` +
      'a version manager picks the Node.js of the current folder.\n',
  );
  process.exit(1);
} else {
  // Until main() settles, an empty event loop must not pass for success (Node.js reports an unsettled top-level
  // await with exit code 13; this entry point has no top-level await).
  let settled = false;
  process.on('exit', (code) => {
    if (!settled && code === 0) {
      process.stderr.write('studio: exited before the command finished (unsettled promise)\n');
      process.exitCode = 13;
    }
  });
  const load = new Function('url', 'return import(url)') as (url: string | URL) => Promise<unknown>;
  Promise.all([load('node:fs'), load('node:url')])
    .then(([fs, url]) => {
      // argv[1] may be a symbolic link to this file (ln -s …/dist/bin.js ~/.local/bin/studio, npm bin links): main.js
      // sits next to the real file, where a static import would have found it.
      const real = (fs as { realpathSync(p: string): string }).realpathSync(process.argv[1]);
      return load(new URL('main.js', (url as { pathToFileURL(p: string): URL }).pathToFileURL(real))) as Promise<{
        main: (argv: string[]) => Promise<number>;
      }>;
    })
    .then(async ({ main }) => {
      const code = await main(process.argv);
      settled = true;
      // Let stdout drain (pipes are asynchronous on macOS) before exiting; nothing may keep the process alive.
      process.stdout.write('', () => process.exit(code));
    })
    .catch((e: unknown) => {
      settled = true;
      process.stderr.write(`${e instanceof Error ? e.stack || e.message : String(e)}\n`);
      process.exit(1);
    });
}
