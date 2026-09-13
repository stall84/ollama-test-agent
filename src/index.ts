import ollama, { type Message } from "ollama";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createTools } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_MD_PATH = path.join(__dirname, "..", "AGENT.md");

// The sandbox root: everything the agent's tools touch is confined here.
// Defaults to this project, but can be pointed at another project to test:
//   npm run dev -- /path/to/other/project ["optional task description"]
const rootDir = path.resolve(process.argv[2] ?? process.cwd());
const taskDescription =
  process.argv[3] ??
  "Inspect this project, figure out an appropriate way to test it (e.g. run its test " +
    "suite or build), run that verification, and report the results honestly.";

console.log(`Project root (sandboxed): ${rootDir}`);

const systemPrompt = await readFile(AGENT_MD_PATH, "utf8");

const {
  listFiles,
  readTextFile,
  writeTextFile,
  runCommand,
  listFilesTool,
  readFileTool,
  writeFileTool,
  runCommandTool,
} = createTools(rootDir);

const tools = [listFilesTool, readFileTool, writeFileTool, runCommandTool];

const messages: Message[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: taskDescription },
];

const MAX_ITERATIONS = 15;
let finishedCleanly = false;

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n========== AGENT ITERATION ${iteration} ==========\n`);

  // ------------------------------------------------------------
  // Ask the model what it wants to do next.
  // ------------------------------------------------------------

  const response = await ollama.chat({
    model: "qwen3-coder:30b",
    messages,
    tools,
    think: false,
  });

  messages.push(response.message);

  console.log("MODEL CONTENT:");
  console.log(response.message.content);

  // ------------------------------------------------------------
  // Did the model request any tools?
  // ------------------------------------------------------------

  const toolCalls = response.message.tool_calls ?? [];

  if (toolCalls.length === 0) {
    // No tools requested means the model considers itself done.
    console.log("\n========== AGENT FINISHED ==========\n");
    finishedCleanly = true;
    break;
  }

  // ------------------------------------------------------------
  // Execute every tool the model requested.
  // ------------------------------------------------------------

  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    const args = toolCall.function.arguments as Record<string, unknown>;

    console.log(`\nTOOL REQUEST: ${toolName}`);
    console.dir(args, { depth: null });

    let content: string;

    try {
      switch (toolName) {
        case "list_files": {
          const result = await listFiles(args.path as string);
          content = JSON.stringify(result);
          break;
        }
        case "read_file": {
          const result = await readTextFile(args.path as string);
          content = JSON.stringify({ content: result });
          break;
        }
        case "write_file": {
          const result = await writeTextFile(
            args.path as string,
            args.content as string
          );
          content = JSON.stringify(result);
          break;
        }
        case "run_command": {
          const result = await runCommand(
            args.executable as string,
            args.args as string[]
          );
          content = JSON.stringify(result);
          break;
        }
        default: {
          content = JSON.stringify({ error: `Unknown tool: ${toolName}` });
        }
      }
    } catch (err) {
      // Surface sandbox/allow-list violations to the model as a tool error
      // rather than crashing the agent loop.
      const message = err instanceof Error ? err.message : String(err);
      content = JSON.stringify({ error: message });
    }

    console.log("\nTOOL RESULT:");
    console.log(content);

    messages.push({
      role: "tool",
      tool_name: toolName,
      content,
    });
  }
}

if (!finishedCleanly) {
  console.log(
    `\n========== STOPPED: reached MAX_ITERATIONS (${MAX_ITERATIONS}) without the model finishing ==========\n`
  );
}
