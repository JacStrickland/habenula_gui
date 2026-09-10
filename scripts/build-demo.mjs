// Build the hosted demo into docs/.
//
// The demo is the same app: same index.html, same app.css, same app.js. The
// only difference is that demo-engine.js is loaded FIRST, which sets
// window.HABENULA_DEMO and flips app.js onto the fixture transport. Nothing is
// forked, so the hosted page cannot drift from the console you run locally.
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const OUT = join(ROOT, "docs");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const f of ["app.css", "app.js", "demo-engine.js"]) {
  await copyFile(join(PUBLIC, f), join(OUT, f));
}

let html = await readFile(join(PUBLIC, "index.html"), "utf8");

// Absolute "/app.css" would 404 under a project-pages subpath
// (user.github.io/repo/), so the demo uses relative URLs.
html = html.replace(/(href|src)="\/([^"]+)"/g, '$1="$2"');

// demo-engine.js must run before app.js so the transport flag is set when
// app.js evaluates it.
html = html.replace('<script src="app.js"></script>', '<script src="demo-engine.js"></script>\n<script src="app.js"></script>');

html = html.replace(
  "<title>Habenula Console</title>",
  "<title>Habenula Console — demo</title>",
);

// The demo must never be mistaken for a console watching a real engine. This
// is the same reasoning as the unreachable-engine banner: a governance UI that
// looks live when it isn't is the failure mode.
const banner = `
<div class="demo-bar">
  <b>Demo</b> — fixture data, no engine behind it. Every panel and decision below
  is the real console code; only the transport is swapped.
  <span class="demo-why">A hosted page can't reach a local engine: an HTTPS page
  fetching <code>http://127.0.0.1</code> is blocked as mixed content, and the
  engine's loopback guard rejects a browser <code>Origin</code>. The working
  console runs on your machine.</span>
  <span class="demo-acts">
    <button class="btn sm" id="btn-reset-demo">Reset demo</button>
    <a class="btn sm" href="https://github.com/JacStrickland/habenula_gui">Source &amp; local install</a>
  </span>
</div>`;
html = html.replace('<div class="shell">', banner + '\n<div class="shell">');

// Wire the reset button after app.js has loaded.
html = html.replace(
  "</body>",
  `<script>
document.getElementById("btn-reset-demo").addEventListener("click", () => {
  window.HABENULA_DEMO.reset();
});
</script>
</body>`,
);

await writeFile(join(OUT, "index.html"), html);

const css = `
/* Demo chrome — only in the hosted build. */
.demo-bar {
  padding: 11px 16px; font-size: 13px; line-height: 1.55;
  background: #2a2211; border-bottom: 1px solid #574a1a; color: #e2c37e;
}
.demo-bar b { color: var(--accent); }
.demo-bar code { font-size: 12px; background: #1e1a0d; padding: 1px 4px; border-radius: 3px; }
.demo-why { display: block; color: #b9a271; font-size: 12px; margin-top: 3px; max-width: 88ch; }
.demo-acts { display: flex; gap: 8px; margin-top: 9px; }
.demo-bar .btn {
  background: #1e1a0d; border-color: #574a1a; color: #e2c37e;
  text-decoration: none; display: inline-flex; align-items: center;
}
/* The demo has no engine, so lifecycle controls would be dishonest affordances. */
#btn-up, #btn-down { display: none; }
`;
await writeFile(join(OUT, "app.css"), (await readFile(join(PUBLIC, "app.css"), "utf8")) + css);

// GitHub Pages runs content through Jekyll by default, which drops files and
// folders beginning with an underscore. Nothing here starts with one today,
// but .nojekyll makes that not a future footgun.
await writeFile(join(OUT, ".nojekyll"), "");

console.log("built docs/ — open docs/index.html or serve the folder");
