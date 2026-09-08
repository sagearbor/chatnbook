// loader.ts has no imports/exports of its own -- it's meant to be dropped
// into third-party sites (WordPress etc.) as a plain classic <script src=...>
// tag, and reads document.currentScript, which is *always null* for
// type="module" scripts per spec. But since packages/widget/package.json
// declares "type": "module" (needed so app.js/a11y.js can use real ESM
// import/export), tsc's NodeNext module emit adds a trailing `export {};`
// to loader.js to mark it as a module too -- which is a hard SyntaxError
// ("Unexpected token 'export'") when the file is loaded as a classic
// script, i.e. exactly how it's actually used. This was caught by the new
// widget smoke test (test/loader.test.mjs), which loads dist/loader.js the
// same way a customer's site does.
//
// Fix: strip the trailing module marker from dist/loader.js only, after
// tsc emits it, so it stays a valid classic script. app.js/a11y.js are
// untouched and remain real ES modules.
import fs from 'fs';
import path from 'path';

const file = path.join(process.cwd(), 'dist', 'loader.js');
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf-8');
  const stripped = content.replace(/\n?export\s*\{\s*\};?\s*$/, '\n');
  if (stripped !== content) {
    fs.writeFileSync(file, stripped);
    console.log('loader.js: stripped trailing ESM export marker (must run as a classic <script>)');
  }
}
