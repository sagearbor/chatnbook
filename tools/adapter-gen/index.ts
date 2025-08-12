import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const idx = args.indexOf('--manifest');
if (idx === -1 || idx === args.length-1) {
  console.error('Usage: generate:adapter --manifest <path>');
  process.exit(1);
}
const manifestPath = args[idx+1];
console.log('Loaded manifest:', manifestPath);

// Stub: copy wordpress templates to platforms_out/wordpress-plugin
const src = path.join(process.cwd(), 'tools', 'adapter-gen', 'templates', 'wordpress');
const dest = path.join(process.cwd(), 'platforms_out', 'wordpress-plugin');
fs.mkdirSync(dest, { recursive: true });

function copyDir(s: string, d: string): void {
  for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, entry.name);
    const dp = path.join(d, entry.name.replace('.tmpl',''));
    if (entry.isDirectory()) { fs.mkdirSync(dp, { recursive: true }); copyDir(sp, dp); }
    else {
      let content = fs.readFileSync(sp, 'utf-8');
      content = content.replace(/{{PLUGIN_NAME}}/g, 'ai-smb-booker');
      fs.writeFileSync(dp, content);
    }
  }
}
copyDir(src, dest);
console.log('Generated WordPress plugin at', dest);
