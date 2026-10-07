/** split.ts <dir>: replaces <dir>/main.tf, formatted, with the files splitHcl lays out. */
import * as fs from 'fs';
import * as path from 'path';
import { splitHcl } from '../lib/hcl';

const dir = process.argv[2];
const main = path.join(dir, 'main.tf');
const files = splitHcl(fs.readFileSync(main, 'utf8'));
fs.rmSync(main);
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
