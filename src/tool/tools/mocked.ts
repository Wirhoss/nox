import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { ToolSet } from "../toolSet";
import { asTextToolResponse } from "../utils";

import type { SyncTool, Tool } from "../../types";

// ============================================================
// FileSystemToolSet
// Lectura, escritura y exploración del sistema de archivos.
// Una LLM los usa para inspeccionar código, leer configs,
// crear parches, navegar repos, etc.
// ============================================================

const readFileSchema = z.object({
  path: z.string().describe("Absolute or relative path to the file to read"),
  offset: z.number().int().positive().optional().describe("Line number to start reading from (1-indexed). Useful for large files."),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to read. Useful for large files."),
});

const writeFileSchema = z.object({
  path: z.string().describe("Absolute or relative path where to write the file. Parent directories are created if needed."),
  content: z.string().describe("Full content to write to the file. Existing content will be overwritten."),
});

const listDirectorySchema = z.object({
  path: z.string().default(".").describe("Directory path to list. Defaults to current directory."),
  recursive: z.boolean().default(false).describe("Whether to list files recursively."),
});

const searchFilesSchema = z.object({
  pattern: z.string().describe("Glob pattern or substring to match against file names (e.g. '*.ts', 'test', 'config')."),
  rootPath: z.string().default(".").describe("Directory to search in."),
  maxResults: z.number().int().positive().default(20).describe("Maximum number of results to return."),
});

class FileSystemToolSet extends ToolSet {
  constructor() {
    super();

    const readFile: SyncTool<typeof readFileSchema> = {
      type: "sync",
      name: "read_file",
      description:
        "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). " +
        "For large files use offset/limit to read a portion. Returns truncated output for files > 50 KB.",
      parameters: readFileSchema,
      call: async ({ path: filePath, offset, limit }) => {
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) {
          return asTextToolResponse({ error: `File not found: ${resolved}` });
        }
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          return asTextToolResponse({ error: `Not a file: ${resolved}` });
        }
        const raw = fs.readFileSync(resolved, "utf-8");
        const lines = raw.split("\n");
        const start = offset ? Math.max(0, offset - 1) : 0;
        const end = limit ? start + limit : lines.length;
        const slice = lines.slice(start, end);
        return asTextToolResponse({
          file: resolved,
          totalLines: lines.length,
          linesReturned: slice.length,
          startLine: start + 1,
          content: slice.join("\n"),
          truncated: end < lines.length,
        });
      },
    };

    const writeFile: SyncTool<typeof writeFileSchema> = {
      type: "sync",
      name: "write_file",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
        "Automatically creates parent directories.",
      parameters: writeFileSchema,
      call: async ({ path: filePath, content }) => {
        const resolved = path.resolve(filePath);
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, content, "utf-8");
        return asTextToolResponse({ file: resolved, bytes: Buffer.byteLength(content, "utf-8") });
      },
    };

    const listDirectory: SyncTool<typeof listDirectorySchema> = {
      type: "sync",
      name: "list_directory",
      description: "List the contents of a directory. Optionally recursive.",
      parameters: listDirectorySchema,
      call: async ({ path: dirPath, recursive }) => {
        const resolved = path.resolve(dirPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return asTextToolResponse({ error: `Directory not found: ${resolved}` });
        }
        if (!recursive) {
          const entries = fs.readdirSync(resolved, { withFileTypes: true });
          return asTextToolResponse({
            directory: resolved,
            entries: entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other",
            })),
          });
        }
        // simple recursive walk
        const walk = (dir: string, prefix = ""): { name: string; type: string; path: string }[] => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const result: { name: string; type: string; path: string }[] = [];
          for (const e of entries) {
            const entryPath = path.join(dir, e.name);
            result.push({
              name: e.name,
              type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other",
              path: prefix + e.name,
            });
            if (e.isDirectory()) {
              result.push(...walk(entryPath, prefix + e.name + "/"));
            }
          }
          return result;
        };
        return asTextToolResponse({ directory: resolved, entries: walk(resolved) });
      },
    };

    const searchFiles: SyncTool<typeof searchFilesSchema> = {
      type: "sync",
      name: "search_files",
      description:
        "Search for files by name pattern. Supports glob patterns like '*.ts' or simple substrings. " +
        "Walks directories recursively and returns matching file paths.",
      parameters: searchFilesSchema,
      call: async ({ pattern, rootPath, maxResults }) => {
        const resolved = path.resolve(rootPath);
        const results: string[] = [];

        const match = (name: string): boolean => {
          if (pattern.includes("*")) {
            const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
            return regex.test(name);
          }
          return name.includes(pattern);
        };

        const walk = (dir: string): void => {
          if (results.length >= maxResults) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              if (results.length >= maxResults) return;
              const entryPath = path.join(dir, e.name);
              if (e.isFile() && match(e.name)) {
                results.push(entryPath);
              } else if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git") {
                walk(entryPath);
              }
            }
          } catch {
            // skip unreadable dirs
          }
        };

        walk(resolved);
        return asTextToolResponse({ pattern, root: resolved, count: results.length, files: results });
      },
    };

    this._tools = { readFile, writeFile, listDirectory, searchFiles };
  }
}

// ============================================================
// ShellToolSet
// Ejecución de comandos en el sistema. Una LLM los usa para
// compilar, correr tests, inspeccionar procesos, gestionar
// paquetes, etc.
// ============================================================

const executeCommandSchema = z.object({
  command: z.string().describe("The shell command to execute (e.g. 'ls -la', 'npm test', 'git status')."),
  timeout: z.number().int().positive().default(30).describe("Timeout in seconds. Default 30."),
  cwd: z.string().optional().describe("Working directory for the command. Defaults to current working directory."),
});

const checkEnvSchema = z.object({
  variable: z.string().optional().describe("Specific environment variable to check. If omitted, returns common vars."),
});

const checkProcessSchema = z.object({
  pattern: z.string().describe("Pattern to match against running process names (e.g. 'node', 'python', 'postgres')."),
});

class ShellToolSet extends ToolSet {
  constructor() {
    super();

    const executeCommand: SyncTool<typeof executeCommandSchema> = {
      type: "sync",
      name: "execute_command",
      description:
        "Execute a bash shell command and return stdout/stderr. " +
        "Use this for running tests, building, checking git status, listing processes, etc.",
      parameters: executeCommandSchema,
      call: async ({ command, timeout, cwd }) => {
        const { execSync } = await import("node:child_process");
        try {
          const output = execSync(command, {
            cwd: cwd || process.cwd(),
            timeout: timeout * 1000,
            encoding: "utf-8",
            maxBuffer: 50 * 1024 * 1024, // 50 MB
          });
          return asTextToolResponse({ exitCode: 0, stdout: output });
        } catch (err: unknown) {
          const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
          return asTextToolResponse({
            exitCode: e.status ?? -1,
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? e.message ?? "Unknown error",
          });
        }
      },
    };

    const checkEnv: SyncTool<typeof checkEnvSchema> = {
      type: "sync",
      name: "check_env",
      description:
        "Check environment variables. Returns the value of a specific variable or a set of common ones (HOME, PATH, NODE_ENV, etc.).",
      parameters: checkEnvSchema,
      call: async ({ variable }) => {
        if (variable) {
          return asTextToolResponse({ variable, value: process.env[variable] ?? "<not set>" });
        }
        const commonVars = ["HOME", "PATH", "NODE_ENV", "PWD", "USER", "SHELL", "LANG", "EDITOR", "TERM"];
        const result: Record<string, string> = {};
        for (const v of commonVars) {
          result[v] = process.env[v] ?? "<not set>";
        }
        return asTextToolResponse(result);
      },
    };

    const checkProcess: SyncTool<typeof checkProcessSchema> = {
      type: "sync",
      name: "check_process",
      description:
        "List running processes matching a name pattern. Useful for checking if a server, database or build process is running.",
      parameters: checkProcessSchema,
      call: async ({ pattern }) => {
        const { execSync } = await import("node:child_process");
        try {
          const raw = execSync(`ps aux | grep -i '${pattern}' | grep -v grep`, {
            encoding: "utf-8",
          });
          const lines = raw.trim().split("\n").filter(Boolean);
          return asTextToolResponse({ pattern, count: lines.length, processes: lines });
        } catch {
          return asTextToolResponse({ pattern, count: 0, processes: [] });
        }
      },
    };

    this._tools = { executeCommand, checkEnv, checkProcess };
  }
}

// ============================================================
// WebToolSet
// Búsqueda y extracción de información web. Una LLM los usa
// para buscar documentación, leer artículos, verificar APIs,
// obtener info actualizada, etc.
// ============================================================

const webSearchSchema = z.object({
  query: z.string().describe("The search query. Be specific with keywords for better results."),
  maxResults: z.number().int().min(1).max(20).default(10).describe("Number of results to return (max 20)."),
  category: z.enum(["general", "news", "it", "science"]).default("general").describe("Search category filter."),
  timeRange: z.enum(["day", "week", "month", "year"]).optional().describe("Time range filter for results."),
});

const webExtractSchema = z.object({
  url: z.string().url().describe("The URL to extract content from."),
  includeMarkdown: z.boolean().default(true).describe("Include extracted markdown content."),
  includeLinks: z.boolean().default(false).describe("Include links found on the page."),
  includeMetadata: z.boolean().default(true).describe("Include page metadata (title, description, author)."),
});

const checkUrlSchema = z.object({
  url: z.string().url().describe("The URL to check."),
  followRedirects: z.boolean().default(true).describe("Whether to follow redirects."),
});

class WebToolSet extends ToolSet {
  constructor() {
    super();

    const webSearch: SyncTool<typeof webSearchSchema> = {
      type: "sync",
      name: "web_search",
      description:
        "Search the web using SearXNG. Returns titles, URLs and snippets. " +
        "Use this to find documentation, articles, APIs, or any up-to-date information.",
      parameters: webSearchSchema,
      call: async ({ query, maxResults, category, timeRange }) => {
      // Mocked: in production this would call SearXNG
      return asTextToolResponse({
          query,
          category,
          timeRange,
          results: [
            {
              title: `[mock] First result for "${query}"`,
              url: "https://example.com/1",
              snippet: "This is a mocked search result for testing purposes.",
            },
            {
              title: `[mock] Second result for "${query}"`,
              url: "https://example.com/2",
              snippet: "Another mocked search result to simulate real web search behavior.",
            },
            {
              title: `[mock] Documentation for "${query}"`,
              url: "https://docs.example.com",
              snippet: "Official documentation page with API reference and examples.",
            },
          ],
          mocked: true,
        });
      },
    };

    const webExtract: SyncTool<typeof webExtractSchema> = {
      type: "sync",
      name: "web_extract",
      description:
        "Extract clean content from a web page. Returns markdown text, links, media and metadata. " +
        "Use this to read full articles, documentation pages or any URL content.",
      parameters: webExtractSchema,
      call: async ({ url, includeMarkdown, includeLinks, includeMetadata }) => {
        // Mocked: in production this would use Crawl4AI
        const result: Record<string, unknown> = { url };
        if (includeMetadata) {
          result.metadata = { title: `[mock] Page title`, description: "Mocked page description.", author: "Unknown" };
        }
        if (includeMarkdown) {
          result.markdown = `# [mock] Page Content\n\nThis is mocked extracted content for testing.\n\nIn production this would contain the full cleaned markdown from ${url}.`;
        }
        if (includeLinks) {
          result.links = ["https://example.com/link1", "https://example.com/link2"];
        }
        result.mocked = true;
        return asTextToolResponse(result);
      },
    };

    const checkUrl: SyncTool<typeof checkUrlSchema> = {
      type: "sync",
      name: "check_url",
      description:
        "Check if a URL is reachable. Returns the HTTP status code, final URL (after redirects) and response headers.",
      parameters: checkUrlSchema,
      call: async ({ url, followRedirects }) => {
        try {
          const response = await fetch(url, { redirect: followRedirects ? "follow" : "manual", signal: AbortSignal.timeout(5000) });
          return asTextToolResponse({
            url,
            status: response.status,
            statusText: response.statusText,
            finalUrl: response.url,
            redirected: response.url !== url,
          });
        } catch (err: unknown) {
          return asTextToolResponse({
            url,
            error: (err as Error).message ?? "Failed to fetch URL",
          });
        }
      },
    };

    this._tools = { webSearch, webExtract, checkUrl };
  }
}

// ============================================================
// Sample tools — array plana para testing con ToolRouter
// ============================================================

const _fs = new FileSystemToolSet();
const _shell = new ShellToolSet();
const _web = new WebToolSet();

const sampleTools: Tool[] = [
  ...Object.values(_fs.tools),
  ...Object.values(_shell.tools),
  ...Object.values(_web.tools),
];

// ============================================================
// Exports
// ============================================================

export { FileSystemToolSet, ShellToolSet, WebToolSet, sampleTools };
