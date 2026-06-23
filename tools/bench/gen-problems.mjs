#!/usr/bin/env node
// Generates the 25-problem starter set under problems/<id>/problem.json.
// Each problem is fixture-light and scored deterministically so the harness
// can run without manual grading. Edit/extend freely.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "problems");

// Each problem: id, title, tags, prompt, optional setup/fixture, checks.
const P = [];
const add = (p) => P.push(p);

// --- debug / bug-fix (exercises /debug, /ralph) ---
add({ id: "p01-debug-off-by-one", title: "Fix off-by-one in sum", tags: ["debug"],
  prompt: "There is a bug in sum.js: it omits the last element. Fix it so sum([1,2,3]) returns 6. Edit only sum.js.",
  fixture: { "sum.js": "export function sum(a){let t=0;for(let i=0;i<a.length-1;i++)t+=a[i];return t}\n" },
  checks: [
    { type: "file_contains", path: "sum.js", value: "i<a.length", label: "loop fixed" },
    { type: "shell_exit_zero", value: "node -e \"import('./sum.js').then(m=>{if(m.sum([1,2,3])!==6)process.exit(1)})\"", label: "sum([1,2,3])===6" },
  ] });

add({ id: "p02-null-guard", title: "Add null guard", tags: ["debug"],
  prompt: "greet.js throws on null input. Make greet(null) return 'Hello, guest'. Keep greet('Ann') returning 'Hello, Ann'.",
  fixture: { "greet.js": "export function greet(n){return 'Hello, '+n.trim()}\n" },
  checks: [
    { type: "shell_exit_zero", value: "node -e \"import('./greet.js').then(m=>{if(m.greet(null)!=='Hello, guest'||m.greet('Ann')!=='Hello, Ann')process.exit(1)})\"", label: "null + normal case" },
  ] });

// --- typecheck / lint (exercises minifier + /verify) ---
add({ id: "p03-tsc-errors", title: "Report tsc errors exactly", tags: ["verify", "typecheck"],
  prompt: "Run a TypeScript typecheck on bad.ts and report the exact file and line of each error. Do not edit any file.",
  setup: "npm i -D typescript >/dev/null 2>&1 || true",
  fixture: { "bad.ts": "const x: number = 'str';\nlet y: string = 42;\n", "tsconfig.json": "{\"compilerOptions\":{\"strict\":true,\"noEmit\":true}}\n" },
  checks: [
    { type: "transcript_regex", value: "bad\\.ts.*1", label: "line 1 reported" },
    { type: "transcript_regex", value: "bad\\.ts.*2", label: "line 2 reported" },
    { type: "transcript_not_contains", value: "const x: number = 0", label: "did not edit" },
  ] });

add({ id: "p04-find-failing-test", title: "Find the failing test in noisy log", tags: ["debug", "minify"],
  prompt: "Run `node noisy.mjs` which prints a long log with one failing assertion in the middle. Name the failing test and the expected vs actual value. Do not edit files.",
  fixture: { "noisy.mjs": genNoisy() },
  checks: [
    { type: "transcript_contains", value: "math_add", label: "named failing test" },
    { type: "transcript_regex", value: "expected.*5|actual.*4", label: "reported expected/actual" },
  ] });

// --- research-codebase ---
add({ id: "p05-research-entrypoint", title: "Locate entrypoint without editing", tags: ["research"],
  prompt: "Find and report the single function that is the program entrypoint in app.js. Report its name and line. Do not edit anything.",
  fixture: { "app.js": "function helper(){}\nfunction main(){console.log('go')}\nmain()\n" },
  checks: [
    { type: "transcript_contains", value: "main", label: "named main" },
    { type: "transcript_not_contains", value: "I edited", label: "no edit claim" },
  ] });

// --- tdd ---
add({ id: "p06-tdd-fizzbuzz", title: "TDD fizzbuzz", tags: ["tdd"],
  prompt: "Create fizzbuzz.js exporting fizzbuzz(n): 'Fizz' for /3, 'Buzz' for /5, 'FizzBuzz' for /15, else the number as string. Then prove it works.",
  checks: [
    { type: "file_exists", path: "fizzbuzz.js", label: "file created" },
    { type: "shell_exit_zero", value: "node -e \"import('./fizzbuzz.js').then(m=>{const f=m.fizzbuzz;if(f(3)!=='Fizz'||f(5)!=='Buzz'||f(15)!=='FizzBuzz'||f(2)!=='2')process.exit(1)})\"", label: "all cases pass" },
  ] });

// --- code-review ---
add({ id: "p07-review-spot-secret", title: "Review: spot hardcoded secret", tags: ["code-review"],
  prompt: "Review config.js and report any security issue you find. Do not change the file.",
  fixture: { "config.js": "export const API_KEY='sk-live-1234567890abcdef'\nexport const PORT=3000\n" },
  checks: [
    { type: "transcript_regex", value: "(secret|api[_ ]?key|hardcoded|credential)", label: "flagged secret" },
  ] });

// --- scoped edit / do-not-overreach ---
add({ id: "p08-scoped-edit", title: "Only edit requested file", tags: ["scope"],
  prompt: "Change ONLY the value of VERSION in version.js from 1 to 2. Do not touch other.js.",
  fixture: { "version.js": "export const VERSION=1\n", "other.js": "export const KEEP=true\n" },
  checks: [
    { type: "file_contains", path: "version.js", value: "VERSION=2", label: "version bumped" },
    { type: "file_contains", path: "other.js", value: "KEEP=true", label: "other.js untouched" },
  ] });

// --- larger reasoning / planning (ralplan) ---
add({ id: "p09-plan-before-edit", title: "Produce a plan, then implement", tags: ["ralplan"],
  prompt: "Implement isPalindrome(s) in pal.js (case-insensitive, ignore non-alphanumerics). First state a short plan, then implement, then verify.",
  checks: [
    { type: "file_exists", path: "pal.js", label: "file created" },
    { type: "shell_exit_zero", value: "node -e \"import('./pal.js').then(m=>{if(!m.isPalindrome('A man, a plan, a canal: Panama')||m.isPalindrome('abc'))process.exit(1)})\"", label: "palindrome logic correct" },
  ] });

add({ id: "p10-refactor-keep-behavior", title: "Refactor keeping behavior", tags: ["code-review", "scope"],
  prompt: "Refactor calc.js to remove duplication but keep add and mul behaving identically. Verify both still work.",
  fixture: { "calc.js": "export function add(a,b){const r=a+b;return r}\nexport function mul(a,b){const r=a*b;return r}\n" },
  checks: [
    { type: "shell_exit_zero", value: "node -e \"import('./calc.js').then(m=>{if(m.add(2,3)!==5||m.mul(2,3)!==6)process.exit(1)})\"", label: "behavior preserved" },
  ] });

// 11-25: parametric variations across skills/difficulty to reach 25 problems
const extra = [
  ["p11-json-parse-fix", "debug", "data.json is invalid JSON (trailing comma). Fix it so it parses. Edit only data.json.",
    { "data.json": "{\n  \"a\": 1,\n  \"b\": 2,\n}\n" },
    [{ type: "shell_exit_zero", value: "node -e \"JSON.parse(require('fs').readFileSync('./data.json','utf8'))\"", label: "valid JSON" }]],
  ["p12-add-test", "tdd", "Write a test file slug.test.mjs that asserts slugify('Hello World')==='hello-world', and implement slugify in slug.mjs to pass it. Run the test.",
    {}, [{ type: "file_exists", path: "slug.mjs", label: "impl created" },
      { type: "shell_exit_zero", value: "node -e \"import('./slug.mjs').then(m=>{if(m.slugify('Hello World')!=='hello-world')process.exit(1)})\"", label: "slugify works" }]],
  ["p13-readme-section", "scope", "Append a '## Usage' section to README.md without altering existing content. The new section must contain the word 'install'.",
    { "README.md": "# Demo\n\nExisting line keep me.\n" },
    [{ type: "file_contains", path: "README.md", value: "Existing line keep me.", label: "kept existing" },
      { type: "file_contains", path: "README.md", value: "## Usage", label: "section added" },
      { type: "file_contains", path: "README.md", value: "install", label: "mentions install" }]],
  ["p14-env-default", "debug", "port.js reads process.env.PORT but crashes when unset. Default to 8080. Keep honoring PORT when set.",
    { "port.js": "export const port=Number(process.env.PORT)\nif(Number.isNaN(port))throw new Error('no port')\n" },
    [{ type: "shell_exit_zero", value: "node -e \"delete process.env.PORT; import('./port.js').then(m=>{if(m.port!==8080)process.exit(1)})\"", label: "defaults to 8080" }]],
  ["p15-grep-count", "research", "Report how many times the word 'TODO' appears across all .js files here. State the number. Do not edit files.",
    { "a.js": "// TODO one\n// TODO two\n", "b.js": "// nothing\n" },
    [{ type: "transcript_regex", value: "\\b2\\b", label: "counted 2" }]],
  ["p16-async-bug", "debug", "fetchAll.mjs forgets to await and returns a Promise instead of data. Fix it to return the resolved array [1,2].",
    { "fetchAll.mjs": "async function one(){return 1}\nasync function two(){return 2}\nexport function fetchAll(){return [one(),two()]}\n" },
    [{ type: "shell_exit_zero", value: "node -e \"import('./fetchAll.mjs').then(async m=>{const r=await m.fetchAll();if(JSON.stringify(r)!=='[1,2]')process.exit(1)})\"", label: "returns [1,2]" }]],
  ["p17-validate-input", "tdd", "Implement clamp(n,min,max) in clamp.mjs. clamp(5,0,3)===3, clamp(-1,0,3)===0, clamp(2,0,3)===2. Verify.",
    {}, [{ type: "shell_exit_zero", value: "node -e \"import('./clamp.mjs').then(m=>{const c=m.clamp;if(c(5,0,3)!==3||c(-1,0,3)!==0||c(2,0,3)!==2)process.exit(1)})\"", label: "clamp correct" }]],
  ["p18-no-delete", "scope", "keep.txt must NOT be deleted. Create new.txt containing 'created'. Leave keep.txt intact.",
    { "keep.txt": "do not delete me\n" },
    [{ type: "file_exists", path: "keep.txt", label: "keep.txt intact" },
      { type: "file_contains", path: "new.txt", value: "created", label: "new.txt created" }]],
  ["p19-regex-extract", "research", "Report the version string found in pkg.txt (format x.y.z). State only the version. Do not edit.",
    { "pkg.txt": "name=demo\nversion=2.4.1\n" },
    [{ type: "transcript_contains", value: "2.4.1", label: "found version" }]],
  ["p20-handle-empty", "debug", "avg.mjs divides by zero on empty arrays. Make avg([]) return 0 and avg([2,4]) return 3.",
    { "avg.mjs": "export const avg=a=>a.reduce((s,x)=>s+x,0)/a.length\n" },
    [{ type: "shell_exit_zero", value: "node -e \"import('./avg.mjs').then(m=>{if(m.avg([])!==0||m.avg([2,4])!==3)process.exit(1)})\"", label: "empty + normal" }]],
  ["p21-cli-arg", "tdd", "Make cli.mjs print 'hi <name>' for `node cli.mjs <name>`, default name 'world'. Verify both.",
    {}, [{ type: "shell_exit_zero", value: "test \"$(node cli.mjs Ann)\" = 'hi Ann' && test \"$(node cli.mjs)\" = 'hi world'", label: "arg + default" }]],
  ["p22-dedupe", "tdd", "Implement unique(arr) in uniq.mjs preserving first-seen order. unique([1,1,2,1,3]) -> [1,2,3]. Verify.",
    {}, [{ type: "shell_exit_zero", value: "node -e \"import('./uniq.mjs').then(m=>{if(JSON.stringify(m.unique([1,1,2,1,3]))!=='[1,2,3]')process.exit(1)})\"", label: "dedupe ordered" }]],
  ["p23-explain-only", "research", "Explain in 2 sentences what mystery.js does. Do not run or edit it.",
    { "mystery.js": "export const f=n=>n<2?n:f(n-1)+f(n-2)\n" },
    [{ type: "transcript_regex", value: "(fibonacci|recursi)", label: "identified fibonacci/recursion" }]],
  ["p24-fix-import", "debug", "main.mjs imports from './util.mjs' but the file is util2.mjs. Fix the import without renaming files.",
    { "main.mjs": "import {x} from './util.mjs'\nconsole.log(x)\n", "util2.mjs": "export const x=42\n" },
    [{ type: "shell_exit_zero", value: "test \"$(node main.mjs)\" = '42'", label: "import fixed" }]],
  ["p25-boundary-test", "verify", "Verify whether isEven.mjs correctly handles negatives and zero. Report PASS or FAIL with evidence. Do not edit.",
    { "isEven.mjs": "export const isEven=n=>n%2===0\n" },
    [{ type: "transcript_regex", value: "(PASS|FAIL)", label: "gave verdict" }]],
];
for (const [id, tag, prompt, fixture, checks] of extra) {
  add({ id, title: id, tags: [tag], prompt, fixture, checks });
}

function genNoisy() {
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push(`console.log('PASS test_${i} ok');`);
  lines.splice(60, 0, "console.log('FAIL math_add expected 5 actual 4');");
  for (let i = 0; i < 120; i++) lines.push(`console.log('PASS more_${i} ok');`);
  return lines.join("\n") + "\n";
}

// write
let n = 0;
for (const p of P) {
  const pdir = join(DIR, p.id);
  mkdirSync(join(pdir, "fixture"), { recursive: true });
  for (const [name, content] of Object.entries(p.fixture || {})) {
    writeFileSync(join(pdir, "fixture", name), content);
  }
  const json = { id: p.id, title: p.title, tags: p.tags, weight: p.weight ?? 1, prompt: p.prompt };
  if (p.setup) json.setup = p.setup;
  json.checks = p.checks || [];
  writeFileSync(join(pdir, "problem.json"), JSON.stringify(json, null, 2) + "\n");
  n++;
}
console.log(`wrote ${n} problems to ${DIR}`);
