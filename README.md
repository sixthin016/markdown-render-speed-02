# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/sixthin016/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/sixthin016/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, hand-written Markdown renderer that produces HTML
byte-identical to [marked](https://github.com/markedjs/marked) 18.1.3
(default options), and renders it fast.

It implements CommonMark 0.31.2 plus the GFM extensions (tables,
strikethrough, task lists, autolinks), covering the full practice set of
720 cases: block quotes, lists, link reference definitions, raw HTML,
emphasis, code spans and fenced code, headings, thematic breaks, and
generated README documents.

## Files

- `parse.js` — the renderer. `parse(markdown)` returns an HTML string.
  No dependencies, no regular expressions on the hot paths: the inline
  scanner walks the source with `charCodeAt`, and the block parser works
  line by line.
- `main.ts` — the driver. It reads the case list from
  `MAKEFUN_INPUT_DIR` (or `./input`) and writes `html.json` to
  `MAKEFUN_OUTPUT_DIR` (or `./output`).

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *emphasised* text.\n');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

## Why it is fast

marked is built on regular expressions; this renderer is built on a
single pass over the input with explicit character classification. The
inline scanner never backtracks over plain text, emphasis pairing uses
the CommonMark delimiter algorithm over a flat node list, and the block
parser reuses one line array. The result renders the 720-case practice
set in well under a second, several times faster than the vendored
marked baseline on the same machine.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wffmhs5a&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
