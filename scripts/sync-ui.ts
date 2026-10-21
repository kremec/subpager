/// <reference types="node" />

import { cp, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const projects = ["subsocial", "subcycle", "subpager"];
const directory = (project: string) =>
  join(
    dirname(projectRoot),
    project,
    project === "subpager" ? "app/src/components/ui" : "src/components/ui",
  );
const source = directory(basename(projectRoot));
const files = await readdir(source);
const check = process.argv.includes("--check");
let differs = false;

for (const project of projects) {
  if (project === basename(projectRoot)) continue;
  const target = directory(project);
  const targetFiles = await readdir(target);

  if (check) {
    for (const file of new Set([...files, ...targetFiles])) {
      const matches =
        files.includes(file) &&
        targetFiles.includes(file) &&
        (await readFile(join(source, file))).equals(
          await readFile(join(target, file)),
        );
      if (!matches) {
        console.error(`${project}: ${file} differs`);
        differs = true;
      }
    }
  } else {
    for (const file of targetFiles) {
      if (!files.includes(file)) await rm(join(target, file));
    }
    await cp(source, target, { recursive: true });
    console.log(`Synced UI to ${project}`);
  }
}

if (differs) process.exitCode = 1;
else if (check) console.log("UI files are identical in all three apps.");
