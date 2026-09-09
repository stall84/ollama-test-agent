import ollama from "ollama";

const listFilesTool = {
  type: "function",
  function: {
    name: "list_files",
    description: "List the files and directories in a directory.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "The directory path to list.",
        },
      },
    },
  },
};

const response = await ollama.chat({
  model: "qwen3-coder:30b",

  messages: [
    {
      role: "user",
      content: "What files are in the current project? Use the list_files tool.",
    },
  ],

  tools: [listFilesTool],

  think: false,
});

console.log("CONTENT:");
console.log(response.message.content);

console.log("\nTOOL CALLS:");
console.dir(response.message.tool_calls, { depth: null });