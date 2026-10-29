// Render the Android launcher icons from the desktop icon design
// (build/icon-flat.svg) with resvg from the root package's node_modules.
// Run from the repo root after `npm install`: node mobile/scripts/make-icons.mjs
//
//   mipmap-*/ic_launcher.png, ic_launcher_round.png  — full icon (Android 7)
//   mipmap-*/ic_launcher_foreground.png              — adaptive-icon layer
//     (the motif without its dark squircle, scaled into the safe zone; the
//     background layer is the solid color in values/ic_launcher_background.xml)
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const res = path.join(root, "mobile", "android", "app", "src", "main", "res");
const svg = readFileSync(path.join(root, "build", "icon-flat.svg"), "utf8");

// The first <path> is the dark squircle background (fill rgb(20,20,20)).
const squircle = svg.match(/<path\b[^>]*fill:rgb\(20,20,20\)[^>]*\/>/);
if (!squircle) throw new Error("icon-flat.svg changed: background squircle not found");
const motif = svg.replace(squircle[0], "");
const open = motif.indexOf(">", motif.indexOf("<svg")) + 1;
const close = motif.lastIndexOf("</svg>");
const FOREGROUND_SCALE = 0.66; // keeps the motif inside the 66dp safe circle
const offset = (1024 * (1 - FOREGROUND_SCALE)) / 2;
const foreground =
	motif.slice(0, open) +
	`<g transform="translate(${offset} ${offset}) scale(${FOREGROUND_SCALE})">` +
	motif.slice(open, close) +
	"</g>" +
	motif.slice(close);

const render = (source, size) => new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng();

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [density, scale] of Object.entries(DENSITIES)) {
	const dir = path.join(res, `mipmap-${density}`);
	const legacy = render(svg, Math.round(48 * scale));
	writeFileSync(path.join(dir, "ic_launcher.png"), legacy);
	writeFileSync(path.join(dir, "ic_launcher_round.png"), legacy);
	writeFileSync(path.join(dir, "ic_launcher_foreground.png"), render(foreground, Math.round(108 * scale)));
}
console.log("Android icons written to", res);
