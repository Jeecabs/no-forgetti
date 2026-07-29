import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { isErrno, isRecord } from "./state-validation.ts";
import { readRuntimeFleet, type RuntimeStatus } from "./runtime-status.ts";
import { readReviewServiceMonitor, type ReviewServiceMonitor } from "./service/monitor.ts";

const execFileAsync = promisify(execFile);
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_PROJECT_SCAN_DIRECTORIES = 20_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".cache"]);

export interface PiProcess {
  pid: number;
  cwd?: string;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

export interface DoctorReport {
  healthy: boolean;
  expectedReleaseVersion: string;
  expectedMemoryPolicyVersion: number;
  package: {
    root: string;
    version?: string;
    globalSources: string[];
    pinned: boolean;
  };
  projects: {
    root?: string;
    scanned: number;
    overrides: string[];
    invalidSettings: string[];
  };
  runtimes: {
    current: RuntimeStatus[];
    mismatched: RuntimeStatus[];
    stale: RuntimeStatus[];
    stopped: RuntimeStatus[];
    piProcesses: PiProcess[];
    unverifiedPiProcesses: PiProcess[];
  };
  worker?: ReviewServiceMonitor["worker"];
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  agentDir: string;
  packageRoot: string;
  projectsRoot?: string;
  expectedReleaseVersion: string;
  expectedMemoryPolicyVersion: number;
  now?: Date;
  loadMonitor?: () => Promise<ReviewServiceMonitor>;
  listPiProcesses?: () => Promise<PiProcess[]>;
}

async function readBoundedJson(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SETTINGS_BYTES) throw new Error(`Invalid JSON file size: ${path}`);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function packageSources(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.packages)) return [];
  return value.packages.filter((item): item is string => typeof item === "string");
}

function containsNoForgetti(value: unknown): boolean {
  if (typeof value === "string") return value.toLowerCase().includes("no-forgetti");
  if (Array.isArray(value)) return value.some(containsNoForgetti);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsNoForgetti);
}

async function projectRoots(projectsRoot: string): Promise<string[]> {
  const root = resolve(projectsRoot);
  const pending = [root];
  const projects: string[] = [];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    if (cursor >= MAX_PROJECT_SCAN_DIRECTORIES) throw new Error("Project scan exceeded its directory limit.");
    const directory = pending.at(cursor)!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      projects.push(directory);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      pending.push(join(directory, entry.name));
    }
  }
  return projects.sort();
}

async function inspectProjects(projectsRoot: string | undefined): Promise<DoctorReport["projects"]> {
  if (!projectsRoot) return { scanned: 0, overrides: [], invalidSettings: [] };
  const roots = await projectRoots(projectsRoot);
  const overrides: string[] = [];
  const invalidSettings: string[] = [];
  for (const root of roots) {
    const path = join(root, ".pi", "settings.json");
    let settings: unknown;
    try {
      settings = await readBoundedJson(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      invalidSettings.push(root);
      continue;
    }
    if (!isRecord(settings)) {
      invalidSettings.push(root);
      continue;
    }
    if (containsNoForgetti(settings.packages) || containsNoForgetti(settings.extensions)
      || containsNoForgetti(settings.disabledExtensions)) overrides.push(root);
  }
  return { root: resolve(projectsRoot), scanned: roots.length, overrides, invalidSettings };
}

async function processCwd(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { maxBuffer: 64 * 1024 });
    return stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) || undefined;
  } catch {
    return undefined;
  }
}

async function listLivePiProcesses(): Promise<PiProcess[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,comm="], { maxBuffer: 1024 * 1024 });
  const pids = stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*([1-9][0-9]*)\s+(\S+)\s*$/u);
    return match?.[2] === "pi" ? [Number(match[1])] : [];
  });
  if (pids.length > 256) throw new Error("Too many live Pi processes to inspect.");
  return Promise.all(pids.map(async (pid) => ({ pid, ...(await processCwd(pid).then((cwd) => cwd ? { cwd } : {})) })));
}

function check(name: string, status: DoctorCheck["status"], message: string): DoctorCheck {
  return { name, status, message };
}

function liveRuntimePids(runtimes: RuntimeStatus[], processes: PiProcess[]): RuntimeStatus[] {
  const pids = new Set(processes.map((process) => process.pid));
  return runtimes.filter((runtime) => runtime.kind === "extension" && pids.has(runtime.pid));
}

function packageCheck(actual: string | undefined, expected: string): DoctorCheck {
  return actual === expected
    ? check("package", "ok", `installed release ${actual}`)
    : check("package", "error", `expected ${expected}, found ${actual ?? "unknown"}`);
}

function globalPackageCheck(sources: string[], pinned: boolean, expected: string): DoctorCheck {
  if (sources.length !== 1) return check("global package", "error", `expected one global No Forgetti source, found ${sources.length}`);
  return pinned
    ? check("global package", "ok", `pinned source ${sources.at(0)}`)
    : check("global package", "error", `global source is not pinned to ${expected}`);
}

function projectSettingsCheck(projects: DoctorReport["projects"]): DoctorCheck {
  if (projects.invalidSettings.length > 0) {
    return check("project settings", "error", `${projects.invalidSettings.length} project settings file(s) are invalid`);
  }
  return projects.overrides.length > 0
    ? check("project settings", "error", `${projects.overrides.length} project override(s) found`)
    : check("project settings", "ok", `${projects.scanned} Git root(s), no No Forgetti override`);
}

function piRuntimeCheck(request: {
  processes: PiProcess[];
  unverified: PiProcess[];
  stale: RuntimeStatus[];
  mismatched: RuntimeStatus[];
}): DoctorCheck {
  if (request.unverified.length > 0 || request.stale.length > 0 || request.mismatched.length > 0) {
    return check(
      "Pi runtimes",
      "error",
      `${request.unverified.length} unverified, ${request.stale.length} stale, ${request.mismatched.length} mismatched`,
    );
  }
  return check("Pi runtimes", "ok", `${request.processes.length} live Pi process(es) loaded the expected release`);
}

function workerCheck(
  monitor: ReviewServiceMonitor | undefined,
  monitorError: unknown,
  workerRuntime: RuntimeStatus | undefined,
): DoctorCheck {
  if (monitorError) {
    const message = monitorError instanceof Error ? monitorError.message : String(monitorError);
    return check("worker", "error", `service monitor failed: ${message}`);
  }
  if (monitor?.mode === "external" && (!monitor.workerFresh || monitor.workerCompatible !== true || !workerRuntime)) {
    return check("worker", "error", "external worker is stale, incompatible, or running another release");
  }
  return check("worker", "ok", monitor?.mode === "external" ? `pid ${monitor.worker?.pid} is current` : "embedded mode");
}

export async function inspectNoForgettiInstallation(options: DoctorOptions): Promise<DoctorReport> {
  const agentDir = resolve(options.agentDir);
  const packageRoot = resolve(options.packageRoot);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid doctor clock.");
  const manifest = await readBoundedJson(join(packageRoot, "package.json"));
  const packageVersion = isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : undefined;
  const globalSettings = await readBoundedJson(join(agentDir, "settings.json"));
  const sources = packageSources(globalSettings).filter((source) => source.toLowerCase().includes("no-forgetti"));
  const pinnedPattern = new RegExp(`@v?${options.expectedReleaseVersion.replaceAll(".", "\\.")}$`, "u");
  const pinned = sources.length === 1 && pinnedPattern.test(sources.at(0)!);
  const projects = await inspectProjects(options.projectsRoot);
  const fleet = await readRuntimeFleet(agentDir, {
    expectedReleaseVersion: options.expectedReleaseVersion,
    expectedMemoryPolicyVersion: options.expectedMemoryPolicyVersion,
    now,
  });
  const processes = await (options.listPiProcesses ?? listLivePiProcesses)();
  const currentExtensions = liveRuntimePids(fleet.current, processes);
  const currentPids = new Set(currentExtensions.map((runtime) => runtime.pid));
  const unverifiedPiProcesses = processes.filter((process) => !currentPids.has(process.pid));
  const staleLive = liveRuntimePids(fleet.stale, processes);
  const mismatchedLive = liveRuntimePids(fleet.mismatched, processes);
  let monitor: ReviewServiceMonitor | undefined;
  let monitorError: unknown;
  try {
    monitor = await (options.loadMonitor ?? (() => readReviewServiceMonitor(agentDir, now)))();
  } catch (error) {
    monitorError = error;
  }
  const workerRuntime = monitor?.worker
    ? fleet.current.find((runtime) => runtime.kind === "worker" && runtime.pid === monitor!.worker!.pid)
    : undefined;

  const checks: DoctorCheck[] = [
    packageCheck(packageVersion, options.expectedReleaseVersion),
    globalPackageCheck(sources, pinned, options.expectedReleaseVersion),
    projectSettingsCheck(projects),
    piRuntimeCheck({
      processes,
      unverified: unverifiedPiProcesses,
      stale: staleLive,
      mismatched: mismatchedLive,
    }),
    workerCheck(monitor, monitorError, workerRuntime),
  ];
  return {
    healthy: checks.every((item) => item.status !== "error"),
    expectedReleaseVersion: options.expectedReleaseVersion,
    expectedMemoryPolicyVersion: options.expectedMemoryPolicyVersion,
    package: { root: packageRoot, ...(packageVersion ? { version: packageVersion } : {}), globalSources: sources, pinned },
    projects,
    runtimes: { ...fleet, piProcesses: processes, unverifiedPiProcesses },
    ...(monitor?.worker ? { worker: monitor.worker } : {}),
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const glyph = { ok: "✓", warning: "!", error: "✗" } as const;
  return [
    `No Forgetti doctor ${report.healthy ? "passed" : "failed"}`,
    `release: ${report.expectedReleaseVersion}`,
    ...report.checks.map((item) => `${glyph[item.status]} ${item.name}: ${item.message}`),
    ...report.projects.overrides.map((path) => `  override: ${path}`),
    ...report.projects.invalidSettings.map((path) => `  invalid settings: ${path}`),
    ...report.runtimes.unverifiedPiProcesses.map((process) => `  unverified Pi pid ${process.pid}${process.cwd ? ` ${process.cwd}` : ""}`),
  ].join("\n");
}
