// Unified diffs a code candidate brings, applied without fuzz to the pure computation files the
// policy names. A hunk is placed by its exact context; its line numbers are only a hint.
import { CODE_FILES, LabPolicyError, MAX_PATCH_BYTES, MAX_PATCH_CHANGED_LINES } from "./policy.ts";

interface Hunk {
  readonly oldStart: number;
  readonly lines: ReadonlyArray<{ readonly op: " " | "-" | "+"; readonly text: string }>;
}

export interface FilePatch {
  readonly path: string;
  readonly hunks: ReadonlyArray<Hunk>;
}

const stripPrefix = (raw: string) => raw.replace(/\t.*$/, "").replace(/^[ab]\//, "");

/**
 * What an added line may not name: a patch is computation over what the module already
 * receives. No module loading, no host, network, process, clock or randomness, no way to build
 * code from a string, and no escape that spells one of these names another way. The rule reads
 * text, so a comment or string that names one is refused too.
 */
export const IMPURE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bimport\b/, "import"],
  [/\brequire\b/, "require"],
  [/\bexport\b/, "export"],
  [/node:/, "node:"],
  [/\bchild_process\b/, "child_process"],
  [/\bprocess\b/, "process"],
  [/\bglobalThis\b|\bglobal\b|\bwindow\b|\bself\b/, "the global object"],
  [/\beval\b/, "eval"],
  [/\bFunction\b/, "Function"],
  [/\bconstructor\b|__proto__|\bprototype\b/, "constructor and prototype access"],
  [/\bReflect\b|\bProxy\b/, "Reflect and Proxy"],
  [/\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/, "network"],
  [/\bDeno\b|\bBun\b|\bWebAssembly\b|\bWorker\b|\bSharedArrayBuffer\b|\bAtomics\b/, "runtimes"],
  [/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/, "timers"],
  [/\bDate\b|\bperformance\b|Math\s*\.\s*random/, "clock and randomness"],
  [/\bBuffer\b|\bconsole\b/, "Buffer and console"],
  [/\\u|\\x/, "escape sequences"],
];

/** The names a file binds to Node built-in modules: an added line may not use them either. */
export function hostBindings(source: string): Array<string> {
  const names: Array<string> = [];
  const pattern =
    /import\s+(?:type\s+)?(?:\*\s+as\s+(\w+)|\{([^}]*)\}|(\w+))\s+from\s+["']node:[^"']+["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) names.push(match[1]);
    if (match[3] !== undefined) names.push(match[3]);
    for (const entry of (match[2] ?? "").split(",")) {
      const local = entry
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (local) names.push(local);
    }
  }
  return names;
}

/** Throws unless `text`, an added line of `path`, is pure computation. */
function assertPure(path: string, text: string, bindings: ReadonlyArray<string> = []) {
  for (const [pattern, name] of IMPURE_PATTERNS) {
    if (pattern.test(text)) {
      throw new LabPolicyError(
        "invalid-change",
        `${path}: an added line uses ${name}; a code candidate may only compute over what the module already receives.`,
      );
    }
  }
  for (const name of bindings) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      throw new LabPolicyError(
        "invalid-change",
        `${path}: an added line uses ${name}, which this file binds to a Node built-in module.`,
      );
    }
  }
}

/** The files and hunks of `patch`; anything but in-place edits of the allowed files is refused. */
export function parsePatch(
  patch: string,
  /** Tests only: hostile patches that exercise the executor's own defenses. */
  check: { readonly pure: boolean } = { pure: true },
): Array<FilePatch> {
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    throw new LabPolicyError(
      "invalid-change",
      `The patch is larger than ${MAX_PATCH_BYTES} bytes.`,
    );
  }
  if (patch.includes("\0")) throw new LabPolicyError("invalid-change", "The patch is binary.");
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: Array<{ path: string; hunks: Array<Hunk> }> = [];
  let changed = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (
      /^(rename|copy|similarity|new file|deleted file|old mode|new mode|Binary files|GIT binary)/.test(
        line,
      )
    ) {
      throw new LabPolicyError(
        "invalid-change",
        "Only in-place edits of existing files are accepted: no renames, new or deleted files, mode changes or binaries.",
      );
    }
    if (!line.startsWith("--- ")) {
      index++;
      continue;
    }
    const next = lines[index + 1];
    if (next === undefined || !next.startsWith("+++ ")) {
      throw new LabPolicyError("invalid-change", `Line ${index + 1}: --- without +++.`);
    }
    const from = stripPrefix(line.slice(4));
    const to = stripPrefix(next.slice(4));
    if (from !== to || from === "/dev/null") {
      throw new LabPolicyError(
        "invalid-change",
        `${from} → ${to}: only in-place edits are accepted.`,
      );
    }
    if (!(CODE_FILES as ReadonlyArray<string>).includes(from)) {
      throw new LabPolicyError(
        "invalid-change",
        `${from} is outside the files a code candidate may change: ${CODE_FILES.join(", ")}.`,
      );
    }
    if (files.some((file) => file.path === from)) {
      throw new LabPolicyError("invalid-change", `${from} appears twice in the patch.`);
    }
    const file = { path: from, hunks: [] as Array<Hunk> };
    files.push(file);
    index += 2;
    while (index < lines.length && lines[index]!.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]!);
      if (header === null) {
        throw new LabPolicyError("invalid-change", `Line ${index + 1}: malformed hunk header.`);
      }
      index++;
      const hunkLines: Array<Hunk["lines"][number]> = [];
      while (index < lines.length) {
        const body = lines[index]!;
        if (body.startsWith("@@") || body.startsWith("--- ")) break;
        if (body === "\\ No newline at end of file") {
          index++;
          continue;
        }
        const op = body[0];
        if (op === " " || op === "-" || op === "+") {
          if (op === "+" && check.pure) assertPure(from, body.slice(1));
          hunkLines.push({ op, text: body.slice(1) });
          if (op !== " ") changed++;
        } else if (body === "") {
          hunkLines.push({ op: " ", text: "" });
        } else {
          break;
        }
        index++;
      }
      if (!hunkLines.some((entry) => entry.op !== " ")) {
        throw new LabPolicyError("invalid-change", `A hunk of ${from} changes nothing.`);
      }
      file.hunks.push({ oldStart: Number(header[1]), lines: hunkLines });
    }
    if (file.hunks.length === 0) {
      throw new LabPolicyError("invalid-change", `${from} has no hunks.`);
    }
  }
  if (files.length === 0) throw new LabPolicyError("invalid-change", "The patch has no file.");
  if (changed > MAX_PATCH_CHANGED_LINES) {
    throw new LabPolicyError(
      "invalid-change",
      `The patch changes ${changed} lines; at most ${MAX_PATCH_CHANGED_LINES}.`,
    );
  }
  return files;
}

const sameAt = (lines: ReadonlyArray<string>, at: number, expected: ReadonlyArray<string>) =>
  expected.every((text, k) => lines[at + k] === text);

/** `source` with `file`'s hunks applied, each at the unique place its old lines match. */
export function applyFilePatch(
  source: string,
  file: FilePatch,
  check: { readonly pure: boolean } = { pure: true },
): string {
  // The file's own host bindings (relevance.ts reads its model with node:fs): usable by the
  // lines already there, never by an added one.
  const bindings = check.pure ? hostBindings(source) : [];
  for (const hunk of check.pure ? file.hunks : []) {
    for (const entry of hunk.lines) {
      if (entry.op === "+") assertPure(file.path, entry.text, bindings);
    }
  }
  const lines = source.split("\n");
  let offset = 0;
  let searchFrom = 0;
  for (const hunk of file.hunks) {
    const old = hunk.lines.filter((entry) => entry.op !== "+").map((entry) => entry.text);
    const added = hunk.lines.filter((entry) => entry.op !== "-").map((entry) => entry.text);
    const hinted = Math.max(0, hunk.oldStart - 1 + offset);
    let at = -1;
    if (hinted >= searchFrom && sameAt(lines, hinted, old)) at = hinted;
    else {
      const places: Array<number> = [];
      for (let k = searchFrom; k + old.length <= lines.length; k++) {
        if (sameAt(lines, k, old)) places.push(k);
      }
      if (places.length !== 1) {
        throw new LabPolicyError(
          "stale-base",
          `A hunk of ${file.path} ${places.length === 0 ? "does not match" : "matches several places of"} the base file.`,
        );
      }
      at = places[0]!;
    }
    lines.splice(at, old.length, ...added);
    offset += added.length - old.length;
    searchFrom = at + added.length;
  }
  return lines.join("\n");
}

/**
 * A unified diff of `before` and `after`, three lines of context: what the operator reads
 * before approving a code candidate, rebuilt from the stored files rather than trusted text.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // Longest common subsequence, from the end: the files a patch may touch are small.
  const lcs: Array<Uint32Array> = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Array<{ op: " " | "-" | "+"; text: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", text: a[i]!, ai: i++, bi: j++ });
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ op: "+", text: b[j]!, ai: i, bi: j++ });
    } else {
      ops.push({ op: "-", text: a[i]!, ai: i++, bi: j });
    }
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === " ") {
      k++;
      continue;
    }
    let start = Math.max(0, k - 3);
    let end = k;
    // Extend over changes separated by at most six unchanged lines.
    for (;;) {
      while (end < ops.length && ops[end]!.op !== " ") end++;
      let next = end;
      while (next < ops.length && ops[next]!.op === " " && next - end < 7) next++;
      if (next < ops.length && ops[next]!.op !== " " && next - end <= 6) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + 3);
    const hunk = ops.slice(start, stop);
    const oldCount = hunk.filter((op) => op.op !== "+").length;
    const newCount = hunk.filter((op) => op.op !== "-").length;
    out.push(`@@ -${hunk[0]!.ai + 1},${oldCount} +${hunk[0]!.bi + 1},${newCount} @@`);
    for (const op of hunk) out.push(`${op.op}${op.text}`);
    k = stop;
    start = stop;
  }
  return `${out.join("\n")}\n`;
}
