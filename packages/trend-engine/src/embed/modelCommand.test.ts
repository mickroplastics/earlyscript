// @effect-diagnostics nodeBuiltinImport:off - downloads into temporary model directories and runs the CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { serveModel, syntheticModelFiles, type ModelMirror } from "../testkit/modelMirror.ts";
import { tempDir } from "../testkit/syntheticCorpus.ts";
import { modelStatus, prepareModel, type ModelProgress } from "./model.ts";
import { PROGRESS_BYTES, prepareModelCommand, type ModelCommandLine } from "./modelCommand.ts";
import { QWEN_FILES, QWEN_REVISION } from "./spec.ts";

const MiB = 1024 * 1024;
const files = syntheticModelFiles({
  "config.json": Buffer.from('{"model":"test"}\n'),
  "onnx/model_quantized.onnx": NodeCrypto.randomBytes(20 * MiB),
});
const contents = Object.fromEntries(files.map(({ file, body }) => [file, body]));
const total = files.reduce((sum, file) => sum + file.bytes, 0);

const mirrors: Array<ModelMirror> = [];
afterEach(async () => {
  for (const mirror of mirrors.splice(0)) await mirror.close();
});
const mirror = async () => {
  const served = await serveModel({ files: contents });
  mirrors.push(served);
  return served;
};

const partials = (dir: string) =>
  NodeFS.readdirSync(NodePath.join(dir, "onnx")).filter((entry) => entry.endsWith(".partial"));

/** The partial a killed process leaves: its pid is dead, so the next prepare may adopt it. */
function orphan(dir: string) {
  const [entry] = partials(dir);
  const dead = NodeChildProcess.spawnSync(NodeProcess.execPath, ["-e", ""]).pid;
  const from = NodePath.join(dir, "onnx", entry!);
  NodeFS.renameSync(from, from.replace(`.${NodeProcess.pid}.`, `.${dead}.`));
}

describe("modelStatus", () => {
  it("reads missing, partial and ready from sizes on disk", async () => {
    const dir = tempDir("model-status");
    expect(await modelStatus(dir, files)).toEqual({
      status: "missing",
      revision: QWEN_REVISION,
      path: dir,
      bytesPresent: 0,
      bytesExpected: total,
    });
    NodeFS.mkdirSync(NodePath.join(dir, "onnx"));
    NodeFS.writeFileSync(NodePath.join(dir, "config.json"), contents["config.json"]!);
    NodeFS.writeFileSync(
      NodePath.join(dir, "onnx", `model_quantized.onnx.1.${NodeCrypto.randomUUID()}.partial`),
      Buffer.alloc(3 * MiB),
    );
    expect(await modelStatus(dir, files)).toMatchObject({
      status: "partial",
      bytesPresent: files[0]!.bytes + 3 * MiB,
    });
    await prepareModel(dir, true, { files, baseUrl: (await mirror()).baseUrl });
    expect(await modelStatus(dir, files)).toMatchObject({ status: "ready", bytesPresent: total });
  });

  it("counts the pinned Qwen files, about 596 MiB", async () => {
    const status = await modelStatus(tempDir("model-status-qwen"));
    expect(status.bytesExpected).toBe(QWEN_FILES.reduce((sum, file) => sum + file.bytes, 0));
    expect(Math.round(status.bytesExpected / MiB)).toBe(596);
  });
});

describe("prepareModel", () => {
  it("reports progress across files and ends with every byte", async () => {
    const dir = tempDir("model-progress");
    const seen: Array<ModelProgress> = [];
    await prepareModel(dir, true, {
      files,
      baseUrl: (await mirror()).baseUrl,
      onProgress: (progress) => seen.push(progress),
    });
    expect(seen.every((progress) => progress.bytesTotal === total)).toBe(true);
    expect(seen.map((progress) => progress.bytesDone)).toEqual(
      seen.map((progress) => progress.bytesDone).toSorted((a, b) => a - b),
    );
    expect(seen.at(-1)).toEqual({
      file: "onnx/model_quantized.onnx",
      bytesDone: total,
      bytesTotal: total,
      sessionBytes: total,
    });
  });

  it("resumes a download cut midway with a range request instead of starting over", async () => {
    const dir = tempDir("model-resume");
    const served = await mirror();
    served.cutNext("onnx/model_quantized.onnx", 7 * MiB);
    await expect(prepareModel(dir, true, { files, baseUrl: served.baseUrl })).rejects.toThrow();
    // The bytes that reached the disk stay, released without an owner. The last chunk in
    // flight may be lost with the connection; the resume starts from what is on disk.
    const cut = await modelStatus(dir, files);
    const kept = cut.bytesPresent - files[0]!.bytes;
    expect(cut.status).toBe("partial");
    expect(kept).toBeGreaterThan(6 * MiB);
    expect(kept).toBeLessThanOrEqual(7 * MiB);

    const seen: Array<ModelProgress> = [];
    await prepareModel(dir, true, {
      files,
      baseUrl: served.baseUrl,
      onProgress: (progress) => seen.push(progress),
    });
    const onnx = served.requests.filter((request) => request.file === "onnx/model_quantized.onnx");
    expect(onnx.map((request) => request.range)).toEqual([null, `bytes=${kept}-`]);
    expect(seen.find((progress) => progress.file === "onnx/model_quantized.onnx")?.bytesDone).toBe(
      cut.bytesPresent,
    );
    expect(
      NodeFS.readFileSync(NodePath.join(dir, "onnx", "model_quantized.onnx")).equals(
        contents["onnx/model_quantized.onnx"]!,
      ),
    ).toBe(true);
    expect(partials(dir)).toEqual([]);
    expect(await modelStatus(dir, files)).toMatchObject({ status: "ready", bytesPresent: total });
  });

  it("adopts the partial of a killed process and keeps a live one's", async () => {
    const dir = tempDir("model-adopt");
    const served = await mirror();
    NodeFS.mkdirSync(NodePath.join(dir, "onnx"), { recursive: true });
    const partialOf = (pid: number) =>
      NodePath.join(dir, "onnx", `model_quantized.onnx.${pid}.${NodeCrypto.randomUUID()}.partial`);
    NodeFS.writeFileSync(
      partialOf(NodeProcess.pid),
      contents["onnx/model_quantized.onnx"]!.subarray(0, 5 * MiB),
    );
    orphan(dir);
    const live = partialOf(NodeProcess.pid);
    NodeFS.writeFileSync(live, Buffer.alloc(1 * MiB));

    const seen: Array<ModelProgress> = [];
    await prepareModel(dir, true, {
      files,
      baseUrl: served.baseUrl,
      onProgress: (progress) => seen.push(progress),
    });
    const onnx = served.requests.filter((request) => request.file === "onnx/model_quantized.onnx");
    expect(onnx.map((request) => request.range)).toEqual([`bytes=${5 * MiB}-`]);
    expect(partials(dir)).toEqual([NodePath.basename(live)]);
    // The adopted 5 MiB count as done but not as transferred: speed is measured on the rest.
    const first = seen.find((progress) => progress.file === "onnx/model_quantized.onnx")!;
    expect(first.bytesDone - first.sessionBytes).toBeGreaterThanOrEqual(5 * MiB);
    expect(seen.at(-1)?.sessionBytes).toBe(total - 5 * MiB);
  });

  it("downloads again a finished file that a byte flip corrupted", async () => {
    const dir = tempDir("model-corrupt-final");
    const served = await mirror();
    await prepareModel(dir, true, { files, baseUrl: served.baseUrl });
    const config = NodePath.join(dir, "config.json");
    const bytes = NodeFS.readFileSync(config);
    bytes[0] = bytes[0]! ^ 0xff;
    NodeFS.writeFileSync(config, bytes);
    // Same size: by sizes it still looks ready; only the hash in prepare can tell.
    expect(await modelStatus(dir, files)).toMatchObject({ status: "ready" });

    await prepareModel(dir, true, { files, baseUrl: served.baseUrl });
    expect(NodeFS.readFileSync(config).equals(contents["config.json"]!)).toBe(true);
    expect(served.requests.filter((request) => request.file === "config.json")).toHaveLength(2);
    expect(await modelStatus(dir, files)).toMatchObject({ status: "ready", bytesPresent: total });
  });

  it("counts a truncated finished file as half there and downloads it again", async () => {
    const dir = tempDir("model-truncated-final");
    const served = await mirror();
    await prepareModel(dir, true, { files, baseUrl: served.baseUrl });
    const onnx = NodePath.join(dir, "onnx", "model_quantized.onnx");
    NodeFS.truncateSync(onnx, 3 * MiB);
    expect(await modelStatus(dir, files)).toMatchObject({
      status: "partial",
      bytesPresent: files[0]!.bytes + 3 * MiB,
    });

    await prepareModel(dir, true, { files, baseUrl: served.baseUrl });
    expect(NodeFS.readFileSync(onnx).equals(contents["onnx/model_quantized.onnx"]!)).toBe(true);
    expect(await modelStatus(dir, files)).toMatchObject({ status: "ready", bytesPresent: total });
  });

  it("still refuses a corrupt finished file when it may not download", async () => {
    const dir = tempDir("model-corrupt-offline");
    await prepareModel(dir, true, { files, baseUrl: (await mirror()).baseUrl });
    NodeFS.writeFileSync(NodePath.join(dir, "config.json"), Buffer.alloc(files[0]!.bytes));
    await expect(prepareModel(dir, false, { files })).rejects.toThrow(/hash mismatch/);
    expect(NodeFS.existsSync(NodePath.join(dir, "config.json"))).toBe(true);
  });

  it("starts over when an adopted partial does not hash to the pinned file", async () => {
    const dir = tempDir("model-adopt-corrupt");
    const served = await mirror();
    NodeFS.mkdirSync(NodePath.join(dir, "onnx"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(
        dir,
        "onnx",
        `model_quantized.onnx.${NodeProcess.pid}.${NodeCrypto.randomUUID()}.partial`,
      ),
      Buffer.alloc(2 * MiB, 7),
    );
    orphan(dir);
    await expect(prepareModel(dir, true, { files, baseUrl: served.baseUrl })).rejects.toThrow(
      /hash mismatch/,
    );
    expect(partials(dir)).toEqual([]);
    await prepareModel(dir, true, { files, baseUrl: served.baseUrl });
    expect(await modelStatus(dir, files)).toMatchObject({ status: "ready" });
  });
});

describe("prepareModelCommand", () => {
  it("writes throttled progress lines and then done", async () => {
    const dir = tempDir("model-command");
    const lines: Array<ModelCommandLine> = [];
    await prepareModelCommand(dir, (line) => lines.push(line), {
      files,
      baseUrl: (await mirror()).baseUrl,
      // Time stands still: only the byte step and file boundaries write a line.
      now: () => 0,
    });
    const progress = lines.filter((line): line is ModelProgress => "bytesDone" in line);
    expect(lines.at(-1)).toEqual({ done: true, path: dir });
    expect(progress.at(-1)?.bytesDone).toBe(total);
    // 20 MiB in steps of 8 MiB, plus the start of each file and the final byte.
    expect(progress.length).toBeLessThanOrEqual(2 + Math.ceil((20 * MiB) / PROGRESS_BYTES) + 1);
    for (const [index, line] of progress.entries()) {
      if (index === 0 || line.file !== progress[index - 1]!.file || line.bytesDone === total)
        continue;
      expect(line.bytesDone - progress[index - 1]!.bytesDone).toBeGreaterThanOrEqual(
        PROGRESS_BYTES,
      );
    }
  });
});

const cli = NodeURL.fileURLToPath(new URL("../cli.ts", import.meta.url));
const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(NodeProcess.execPath, [cli, ...args], {
      env: { ...NodeProcess.env, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
const jsonLines = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("engine model", () => {
  it("prints the status of an empty directory", async () => {
    const dir = tempDir("model-cli-status");
    const { code, stdout } = await runCli(["model", "status", "--models", dir]);
    expect(code).toBe(0);
    expect(jsonLines(stdout)).toEqual([
      {
        status: "missing",
        revision: QWEN_REVISION,
        path: dir,
        bytesPresent: 0,
        bytesExpected: QWEN_FILES.reduce((sum, file) => sum + file.bytes, 0),
      },
    ]);
  });

  it("ends a failed download with an error line the server can word", async () => {
    const served = await serveModel({ files: {} });
    mirrors.push(served);
    const dir = tempDir("model-cli-404");
    const { code, stdout } = await runCli(["model", "prepare", "--models", dir], {
      EARLYSCRIPT_MODEL_BASE_URL: served.baseUrl,
    });
    expect(code).toBe(1);
    expect(jsonLines(stdout)).toEqual([
      { error: { code: "http", message: "Model download failed: HTTP 404" } },
    ]);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await runCli(["model", "remove"])).code).toBe(64);
  });
});
