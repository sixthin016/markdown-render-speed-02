// main.ts — driver for markdown-render-speed-02.
// Reads the case list from the input directory (MAKEFUN_INPUT_DIR, default
// /input), renders every case on its own with parse() from parse.js, and
// writes the HTML strings, in order, to html.json in the output directory
// (MAKEFUN_OUTPUT_DIR, default /output).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const rendered = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) rendered[i] = parse(cases[i].markdown);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
