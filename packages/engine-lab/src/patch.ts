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

/** The files and hunks of `patch`; anything but in-place edits of the allowed files is refused. */
export function parsePatch(patch: string): Array<FilePatch> {
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
export function applyFilePatch(source: string, file: FilePatch): string {
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
