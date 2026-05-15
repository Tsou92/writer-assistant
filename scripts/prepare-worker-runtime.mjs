import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeDir = join(root, "worker-runtime");
const cacheDir = join(root, "build-runtime");
const nodeVersion = "24.15.0";

function resolveNodeTarget() {
  const override = process.env.GONGWEN_NODE_TARGET;
  if (override && /^(darwin|linux|win)-(x64|arm64)$/.test(override)) {
    const [platform, arch] = override.split("-");
    return buildTarget(platform, arch);
  }
  const platform = process.platform === "win32" ? "win" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return buildTarget(platform, arch);
}

function buildTarget(platform, arch) {
  if (!["darwin", "linux", "win"].includes(platform)) {
    throw new Error(`暂不支持的 Node 平台：${platform}`);
  }
  const ext = platform === "win" ? "zip" : "tar.gz";
  const archiveBase = `node-v${nodeVersion}-${platform}-${arch}`;
  return {
    platform,
    arch,
    archive: `${archiveBase}.${ext}`,
    archiveBase,
    ext,
    binRelPath: platform === "win" ? "node.exe" : "bin/node"
  };
}

const target = resolveNodeTarget();
const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${target.archive}`;
const nodeExtracted = join(cacheDir, target.archiveBase);
const nodeBinary = join(nodeExtracted, target.binRelPath);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function download(url, output) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(output);
    get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败 ${response.statusCode}: ${url}`));
        response.resume();
        return;
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

async function hashFiles(paths) {
  const hash = createHash("sha256");
  hash.update(`${target.platform}-${target.arch}\n`);
  for (const path of paths) {
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

async function extractArchive(archivePath) {
  if (target.ext === "tar.gz") {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", cacheDir]);
  } else {
    if (process.platform === "win32") {
      await execFileAsync("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${cacheDir}' -Force`
      ]);
    } else {
      await execFileAsync("unzip", ["-q", archivePath, "-d", cacheDir]);
    }
  }
}

async function prepareNode() {
  await mkdir(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, target.archive);
  if (!(await exists(archivePath))) {
    console.log(`下载 Node 运行时：${nodeUrl}`);
    await download(nodeUrl, archivePath);
  }
  if (!(await exists(nodeBinary))) {
    console.log(`解压 Node 运行时：${basename(archivePath)}`);
    await extractArchive(archivePath);
  }
}

async function prepareRuntime() {
  await prepareNode();
  const stampPath = join(runtimeDir, ".runtime-stamp");
  const nextStamp = await hashFiles([
    join(root, "package-lock.json"),
    join(root, "package.json"),
    join(root, "server", "index.mjs")
  ]);
  const currentStamp = await readFile(stampPath, "utf8").catch(() => "");
  if (currentStamp === nextStamp && await exists(join(runtimeDir, "app", "node_modules"))) {
    console.log("worker-runtime 已是最新。");
    return;
  }

  console.log(`准备生产 worker-runtime (${target.platform}-${target.arch})。`);
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(join(runtimeDir, "node"), { recursive: true });
  await mkdir(join(runtimeDir, "app"), { recursive: true });
  if (target.platform === "win") {
    await cp(join(nodeExtracted, "node.exe"), join(runtimeDir, "node", "node.exe"));
  } else {
    await cp(join(nodeExtracted, "bin"), join(runtimeDir, "node", "bin"), { recursive: true });
  }
  await cp(join(root, "server"), join(runtimeDir, "app", "server"), { recursive: true });
  await cp(join(root, "package.json"), join(runtimeDir, "app", "package.json"));
  await cp(join(root, "package-lock.json"), join(runtimeDir, "app", "package-lock.json"));
  await execFileAsync("npm", ["ci", "--omit=dev", "--prefix", join(runtimeDir, "app")], {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  await writeFile(stampPath, nextStamp, "utf8");
}

await prepareRuntime();
