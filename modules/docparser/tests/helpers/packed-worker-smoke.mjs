#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const consumerRoot = process.cwd();
const runtimeDirectory = join(consumerRoot, "dist", "pi-docparser");
const workerPath = join(runtimeDirectory, "native-worker.mjs");
const protocol = await import(pathToFileURL(join(runtimeDirectory, "native-protocol.mjs")).href);

async function run(operation, payload) {
  const jobId = `runtime-native-worker-${operation}`;
  const stagingDir = join(consumerRoot, `.${operation}-staging`);
  await mkdir(stagingDir);
  await writeFile(join(stagingDir, ".native-job-owner"), jobId);
  const request = {
    version: protocol.PROTOCOL_VERSION,
    operation,
    jobId,
    inputPath: join(consumerRoot, "minimal.pdf"),
    stagingDir,
    ...payload,
  };
  protocol.validateWorkerRequest(request);
  const child = spawn(process.execPath, [workerPath], {
    cwd: consumerRoot,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
    signal: AbortSignal.timeout(30_000),
  });
  child.stdout.resume();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-64 * 1024);
  });
  const requestPipe = child.stdio[3];
  const responsePipe = child.stdio[4];
  assert.ok(requestPipe && typeof requestPipe !== "number" && "end" in requestPipe);
  assert.ok(
    responsePipe && typeof responsePipe !== "number" && Symbol.asyncIterator in responsePipe,
  );
  const responsePromise = protocol.readSingleFrame(
    responsePipe,
    protocol.RESPONSE_MAX_BYTES,
    "Runtime worker response",
  );
  const closePromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  requestPipe.end(
    protocol.encodeFrame(request, protocol.REQUEST_MAX_BYTES, "Runtime worker request"),
  );
  const [response, close] = await Promise.all([responsePromise, closePromise]);
  assert.deepEqual(close, { code: 0, signal: null }, stderr);
  protocol.validateWorkerResponse(response, request);
  assert.equal(response.ok, true, response.error?.message);
  await assert.rejects(stat(stagingDir), { code: "ENOENT" });
  return response.result;
}

const config = {
  outputFormat: "json",
  ocrEnabled: false,
  numWorkers: 1,
  maxPages: 1,
  dpi: 72,
  preserveVerySmallText: false,
  quiet: true,
};
const outputPath = join(consumerRoot, "parsed.json");
const parsedResult = await run("parse", { outputPath, config });
assert.equal(parsedResult.outputPath, outputPath);
assert.equal(parsedResult.pageCount, 1);
const parsed = JSON.parse(await readFile(outputPath, "utf8"));
assert.deepEqual(Object.keys(parsed), ["pages", "text"]);
assert.equal(parsed.text, "Hello Pi");
assert.equal(parsed.pages.length, 1);
assert.equal((await stat(outputPath)).size, parsedResult.outputBytes);
const searched = await run("search", {
  phrase: "Hello",
  caseSensitive: false,
  maxResults: 10,
  config,
});
assert.equal(searched.hits.length, 1);
assert.equal(searched.hits[0].text, "Hello");
assert.equal(searched.hits[0].pageNum, 1);
assert.equal(searched.truncatedByCount, false);
assert.equal(searched.truncatedByBytes, false);
const screenshots = await run("screenshot", {
  outputDir: join(consumerRoot, "screenshots"),
  pages: [1],
  dpi: 72,
});
assert.equal(screenshots.screenshots.length, 1);
assert.deepEqual(
  (await readFile(screenshots.screenshots[0].outputPath)).subarray(0, 8),
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
);
assert.equal((await stat(screenshots.screenshots[0].outputPath)).size, screenshots.totalBytes);
