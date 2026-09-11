// The widget app is deliberately unbundled (see CLAUDE.md's "Widget"
// section): app.html is served as-is by the API (GET /widget/app.html) and
// loads dist/app.js as a plain ES module script tag. tsc only emits .js from
// .ts sources, so copy the static .html into dist as a build step here
// rather than pulling in a bundler for one file.
import fs from 'fs';
import path from 'path';

const srcFile = path.join(process.cwd(), 'src', 'app.html');
const outDir = path.join(process.cwd(), 'dist');
const outFile = path.join(outDir, 'app.html');

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(srcFile, outFile);
console.log('copied src/app.html -> dist/app.html');
