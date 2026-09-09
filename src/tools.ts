import { readdir } from "node:fs/promises";

async function listFiles(path: string): Promise<string[]> {
  return await readdir(path);
};

export const listFilesTool = {
    type: "function",
    function: {
      name: "listFiles",
      description: "List the files and directories at a given path.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "The directory path to inspect."
          }
        },
        
      }
    }
  }
