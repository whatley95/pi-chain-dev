const fs2 = require("fs");
let lines = fs2.readFileSync("src/project-map.ts","utf8").split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].endsWith('join("') && i + 1 < lines.length && lines[i + 1].trim() === '");') {
    console.log("Found broken join at line " + (i + 1));
    lines[i] = lines[i] + '\n");';
    lines.splice(i + 1, 1);
  }
}
fs2.writeFileSync("src/project-map.ts", lines.join("\n"), "utf8");
console.log("Done");
