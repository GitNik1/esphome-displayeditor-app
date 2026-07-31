// Measure the JS geometry port against the Qt reference manifest, using the
// module's own exported API - not a reimplementation of it.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRATCH = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.slice(1)));
const REF = path.join(SCRATCH, "reference");
const MODULE = pathToFileURL(
  "C:/Users/nriedle/Desktop/clode/esphome-displayeditor-app/esphome_displayeditor/frontend/glowline/geometry.js",
).href;

const { buildPath, measurePath, pointAtLength, angleAtLength } = await import(MODULE);
const manifest = JSON.parse(fs.readFileSync(path.join(REF, "manifest.json"), "utf8"));

let worstLength = 0;
let worstPoint = 0;
let worstAngle = 0;

for (const [name, entry] of Object.entries(manifest)) {
  entry.strokes.forEach((stroke, si) => {
    const reference = entry.paths[si];
    const measure = measurePath(
      buildPath(stroke.points, stroke.corner_radius, stroke.mode, stroke.closed),
    );

    const lengthErr = Math.abs(measure.length - reference.length) / Math.max(1, reference.length);
    const last = reference.samples.length - 1;
    let maxPoint = 0;
    let maxAngle = 0;

    reference.samples.forEach(([rx, ry, rangle], i) => {
      const d = (i / last) * measure.length;
      // The final sample sits exactly on the end; pointAtLength wraps there.
      const [x, y] = i === last
        ? measure.points[measure.points.length - 1]
        : pointAtLength(measure, d);
      maxPoint = Math.max(maxPoint, Math.hypot(x - rx, y - ry));

      if (i < last) {
        let diff = Math.abs(angleAtLength(measure, d) - rangle) % 360;
        if (diff > 180) diff = 360 - diff;
        maxAngle = Math.max(maxAngle, diff);
      }
    });

    worstLength = Math.max(worstLength, lengthErr);
    worstPoint = Math.max(worstPoint, maxPoint);
    worstAngle = Math.max(worstAngle, maxAngle);
    console.log(
      `${name}[${si}]`.padEnd(24)
      + `Laenge ${reference.length.toFixed(2)} vs ${measure.length.toFixed(2)} `
      + `(${(lengthErr * 100).toFixed(3)}%)`.padEnd(12)
      + `  Punkt ${maxPoint.toFixed(3)}px  Winkel ${maxAngle.toFixed(2)}deg`,
    );
  });
}

console.log("");
console.log(`Schlechtester Laengenfehler: ${(worstLength * 100).toFixed(3)}%`);
console.log(`Schlechtester Punktfehler:   ${worstPoint.toFixed(3)} px`);
console.log(`Schlechtester Winkelfehler:  ${worstAngle.toFixed(2)} Grad`);
