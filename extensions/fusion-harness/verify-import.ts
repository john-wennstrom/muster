import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

interface ImportManifest {
  source: string;
  commit: string;
  files: string[];
}

const EXPECTED_COMMIT = "51f1d85499a1292cb79036d6ae237db7ea52096e";
const EXPECTED_NOTICE = `MIT License

Copyright (c) 2026 IndyDevDan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const root = resolve(import.meta.dir, "../..");
const manifest = JSON.parse(
  await readFile(resolve(import.meta.dir, "import-manifest.json"), "utf8"),
) as ImportManifest;

if (manifest.commit !== EXPECTED_COMMIT) {
  throw new Error(`Unexpected Fusion import commit: ${manifest.commit}`);
}

if (new Set(manifest.files).size !== manifest.files.length) {
  throw new Error("Fusion import manifest contains duplicate paths");
}

for (const path of manifest.files) {
  if (isAbsolute(path) || path.split("/").includes("..")) {
    throw new Error(`Unsafe Fusion import path: ${path}`);
  }

  await readFile(resolve(root, path));
}

const notices = await readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
if (!notices.includes(EXPECTED_NOTICE)) {
  throw new Error("THIRD_PARTY_NOTICES.md does not contain the Fusion MIT notice");
}

console.log(
  `Verified ${manifest.files.length} Fusion files from ${manifest.commit} and the required MIT notice.`,
);