import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 10_000;
const COMMAND_TIMEOUT_MS = 60_000;

// Only these executables/subcommands may run, and only inside the sandbox root.
// This intentionally excludes anything that writes history, pushes, or installs
// beyond the project (no commit/push/reset/checkout, no arbitrary shell).
const ALLOWED_COMMANDS: Record<string, Set<string>> = {
  npm: new Set(["test", "run", "install", "ci", "ls", "list", "outdated", "audit", "build"]),
  git: new Set(["status", "diff", "log", "show", "branch"]),
};

// "npm run dev" starts this very agent, which would call an LLM that could call
// "npm run dev" again -- an unbounded, resource-consuming recursive spawn.
const BLOCKED_NPM_RUN_SCRIPTS = new Set(["dev"]);

// Blocks shell metacharacters/injection attempts even though execFile never
// spawns a shell; this keeps arguments limited to plausible CLI tokens.
const SAFE_ARG = /^[A-Za-z0-9_.:@/=-]+$/;

/** Resolves a user-supplied path against the sandbox root and rejects escapes. */
function resolveSafePath(rootDir: string, inputPath: string): string {
  const resolved = path.resolve(rootDir, inputPath);
  const rel = path.relative(rootDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to access "${inputPath}": it resolves outside the project root (${rootDir}).`
    );
  }
  return resolved;
}

/**
 * Builds the tool implementations and their Ollama tool-call schemas, all
 * scoped to operate only within `rootDir`.
 */
export function createTools(rootDir: string) {
  async function listFiles(dirPath: string): Promise<string[]> {
    const safePath = resolveSafePath(rootDir, dirPath);
    return await readdir(safePath);
  }

  async function readTextFile(filePath: string): Promise<string> {
    const safePath = resolveSafePath(rootDir, filePath);
    return await readFile(safePath, "utf8");
  }

  async function writeTextFile(
    filePath: string,
    content: string
  ): Promise<{ path: string; bytesWritten: number }> {
    const safePath = resolveSafePath(rootDir, filePath);
    await mkdir(path.dirname(safePath), { recursive: true });
    await writeFile(safePath, content, "utf8");
    return {
      path: path.relative(rootDir, safePath),
      bytesWritten: Buffer.byteLength(content, "utf8"),
    };
  }

  async function runCommand(
    executable: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number | string; error?: string }> {
    const allowedSubcommands = ALLOWED_COMMANDS[executable];
    if (!allowedSubcommands) {
      throw new Error(
        `Executable "${executable}" is not allow-listed. Allowed executables: ${Object.keys(
          ALLOWED_COMMANDS
        ).join(", ")}.`
      );
    }
    const subcommand = args[0];
    if (!subcommand || !allowedSubcommands.has(subcommand)) {
      throw new Error(
        `Subcommand "${subcommand ?? ""}" is not allowed for "${executable}". Allowed: ${[
          ...allowedSubcommands,
        ].join(", ")}.`
      );
    }
    for (const arg of args) {
      if (!SAFE_ARG.test(arg)) {
        throw new Error(`Argument "${arg}" contains disallowed characters.`);
      }
    }
    if (executable === "npm" && subcommand === "run" && args[1] && BLOCKED_NPM_RUN_SCRIPTS.has(args[1])) {
      throw new Error(
        `Running "npm run ${args[1]}" is blocked because it would recursively launch this agent itself.`
      );
    }

    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        cwd: rootDir,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return {
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: 0,
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string; message: string };
      return {
        stdout: (e.stdout ?? "").slice(0, MAX_OUTPUT_CHARS),
        stderr: (e.stderr ?? "").slice(0, MAX_OUTPUT_CHARS),
        exitCode: e.code ?? 1,
        error: e.message,
      };
    }
  }

  const listFilesTool = {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List the files and directories in a given directory, relative to the project root.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "The directory path to list, relative to the project root.",
          },
        },
      },
    },
  };

  const readFileTool = {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read and return the complete text contents of a file. Use this to inspect source code, configuration files, test files, package manifests, or documentation.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "The path of the text file to read, relative to the project root.",
          },
        },
      },
    },
  };

  const writeFileTool = {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file within the project root. Use this to add or edit test scripts, fixtures, or notes. Cannot write outside the project root.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: {
            type: "string",
            description: "The file path to write, relative to the project root.",
          },
          content: {
            type: "string",
            description: "The full text content to write to the file.",
          },
        },
      },
    },
  };

  const runCommandTool = {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run an allow-listed command inside the project root to build, test, or inspect the project. " +
        "Only 'npm' (test/run/install/ci/ls/list/outdated/audit/build) and 'git' (status/diff/log/show/branch) " +
        "are permitted. Cannot run arbitrary shell commands or mutate git history.",
      parameters: {
        type: "object",
        required: ["executable", "args"],
        properties: {
          executable: {
            type: "string",
            enum: Object.keys(ALLOWED_COMMANDS),
            description: "The base executable to run.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description:
              'Arguments to pass, e.g. ["test"], ["run", "build"], or ["status"]. First element must be an allowed subcommand.',
          },
        },
      },
    },
  };

  return {
    listFiles,
    readTextFile,
    writeTextFile,
    runCommand,
    listFilesTool,
    readFileTool,
    writeFileTool,
    runCommandTool,
  };
}