import { z } from "zod";
import type { SyncTool, Tool, ToolResponse } from "../types";

/**
 * Hardcoded test tools for agent experimentation.
 */

function asText(result: unknown): ToolResponse {
  return [{ type: "text", text: JSON.stringify(result) }];
}

// --- Schemas ---

const getWeatherSchema = z.object({
  city: z.string().describe("The city name to get weather for"),
  unit: z.enum(["celsius", "fahrenheit"]).optional().describe("Temperature unit"),
});

const calculateSchema = z.object({
  expression: z.string().describe("The mathematical expression to evaluate (e.g. '2 + 3 * 4')"),
});

const searchWebSchema = z.object({
  query: z.string().describe("The search query string"),
  maxResults: z.number().optional().describe("Maximum number of results to return"),
});

const getTimeSchema = z.object({
  timezone: z.string().optional().describe("The IANA timezone (e.g. 'America/New_York', 'Europe/London')"),
});

const listFilesSchema = z.object({
  path: z.string().describe("The directory path to list"),
  recursive: z.boolean().optional().describe("Whether to list files recursively"),
});

const translateSchema = z.object({
  text: z.string().describe("The text to translate"),
  sourceLang: z.string().optional().describe("Source language code (e.g. 'en', 'es', 'fr')"),
  targetLang: z.string().describe("Target language code (e.g. 'en', 'es', 'fr')"),
});

const summarizeSchema = z.object({
  text: z.string().describe("The text to summarize"),
  maxLength: z.number().optional().describe("Maximum length of the summary in words"),
});

const sendEmailSchema = z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body content"),
  cc: z.array(z.string()).optional().describe("List of CC recipients"),
});

// --- Tools ---

const getWeatherTool: SyncTool<typeof getWeatherSchema> = {
  type: "sync",
  name: "get_weather",
  description: "Get the current weather for a given location",
  parameters: getWeatherSchema,
  call: async (params) => {
    const city = params.city;
    const unit = params.unit || "celsius";
    const mockTemps: Record<string, { celsius: number; fahrenheit: number }> = {
      "new york": { celsius: 22, fahrenheit: 72 },
      london: { celsius: 15, fahrenheit: 59 },
      tokyo: { celsius: 28, fahrenheit: 82 },
      paris: { celsius: 20, fahrenheit: 68 },
      sydney: { celsius: 12, fahrenheit: 54 },
    };
    const key = city.toLowerCase();
    const temp = mockTemps[key] || { celsius: Math.floor(Math.random() * 35), fahrenheit: Math.floor(Math.random() * 60) + 32 };
    const conditions = ["Sunny", "Cloudy", "Rainy", "Partly Cloudy", "Overcast"];
    return asText({
      city,
      temperature: temp[unit],
      unit,
      condition: conditions[Math.floor(Math.random() * conditions.length)],
      humidity: Math.floor(Math.random() * 60) + 30,
    });
  },
};

const calculateTool: SyncTool<typeof calculateSchema> = {
  type: "sync",
  name: "calculate",
  description: "Perform a mathematical calculation",
  parameters: calculateSchema,
  call: async (params) => {
    const expression = params.expression;
    try {
      const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      return asText({ expression, result });
    } catch {
      return asText({ expression, error: "Invalid mathematical expression" });
    }
  },
};

const searchWebTool: SyncTool<typeof searchWebSchema> = {
  type: "sync",
  name: "search_web",
  description: "Search the web for information",
  parameters: searchWebSchema,
  call: async (params) => {
    const query = params.query;
    const maxResults = params.maxResults || 5;
    const mockResults = [
      { title: `${query} - Overview`, url: `https://example.com/${query.replace(/\s+/g, "-")}`, snippet: `A comprehensive guide to ${query}...` },
      { title: `Understanding ${query}`, url: `https://learn.example.com/${query.replace(/\s+/g, "-")}`, snippet: `Learn everything about ${query} in this tutorial...` },
      { title: `${query} - Latest News`, url: `https://news.example.com/${query.replace(/\s+/g, "-")}`, snippet: `Breaking news and updates about ${query}...` },
      { title: `${query} Wiki`, url: `https://wiki.example.com/${query.replace(/\s+/g, "-")}`, snippet: `The ${query} entry on Example Wiki...` },
      { title: `${query} - Documentation`, url: `https://docs.example.com/${query.replace(/\s+/g, "-")}`, snippet: `Official documentation for ${query}...` },
    ];
    return asText({ query, count: Math.min(maxResults, mockResults.length), results: mockResults.slice(0, maxResults) });
  },
};

const getTimeTool: SyncTool<typeof getTimeSchema> = {
  type: "sync",
  name: "get_time",
  description: "Get the current date and time in a specific timezone",
  parameters: getTimeSchema,
  call: async (params) => {
    const timezone = params.timezone || "UTC";
    const now = new Date();
    const formatted = now.toLocaleString("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "medium" });
    return asText({ timezone, datetime: now.toISOString(), formatted });
  },
};

const listFilesTool: SyncTool<typeof listFilesSchema> = {
  type: "sync",
  name: "list_files",
  description: "List files in a directory",
  parameters: listFilesSchema,
  call: async (params) => {
    const path = params.path;
    const recursive = params.recursive || false;
    const mockFiles = [
      { name: "README.md", type: "file", size: 2048 },
      { name: "src", type: "directory" },
      { name: "package.json", type: "file", size: 512 },
      { name: "tests", type: "directory" },
    ];
    const nestedFiles = recursive ? [{ name: "src/index.ts", type: "file", size: 1024 }, { name: "src/utils.ts", type: "file", size: 768 }] : [];
    return asText({ path, recursive, files: [...mockFiles, ...nestedFiles] });
  },
};

const translateTool: SyncTool<typeof translateSchema> = {
  type: "sync",
  name: "translate",
  description: "Translate text from one language to another",
  parameters: translateSchema,
  call: async (params) => {
    const text = params.text;
    const sourceLang = params.sourceLang || "auto";
    const targetLang = params.targetLang;
    const mockTranslations: Record<string, Record<string, string>> = {
      "hello world": { es: "Hola mundo", fr: "Bonjour le monde", de: "Hallo Welt" },
      "goodbye": { es: "Adiós", fr: "Au revoir", de: "Auf Wiedersehen" },
      "thank you": { es: "Gracias", fr: "Merci", de: "Danke" },
    };
    const translated = mockTranslations[text.toLowerCase()]?.[targetLang] || `[${targetLang}] ${text}`;
    return asText({ text, sourceLang, targetLang, translated });
  },
};

const summarizeTool: SyncTool<typeof summarizeSchema> = {
  type: "sync",
  name: "summarize",
  description: "Summarize a piece of text",
  parameters: summarizeSchema,
  call: async (params) => {
    const text = params.text;
    const maxLength = params.maxLength || 50;
    const words = text.split(/\s+/);
    const summary = words.slice(0, maxLength).join(" ");
    return asText({
      summary: summary + (words.length > maxLength ? "..." : ""),
      originalLength: words.length,
      summaryLength: Math.min(words.length, maxLength),
    });
  },
};

const sendEmailTool: SyncTool<typeof sendEmailSchema> = {
  type: "sync",
  name: "send_email",
  description: "Send an email to a recipient",
  parameters: sendEmailSchema,
  call: async (params) => {
    const to = params.to;
    const subject = params.subject;
    const body = params.body;
    const cc = params.cc || [];
    const messageId = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return asText({
      messageId,
      to,
      cc,
      subject,
      status: "sent",
      timestamp: new Date().toISOString(),
      note: "Mock email - not actually sent",
    });
  },
};

export const testTools: Tool[] = [
  getWeatherTool,
  calculateTool,
  searchWebTool,
  getTimeTool,
  listFilesTool,
  translateTool,
  summarizeTool,
  sendEmailTool,
];

export {
  getWeatherTool,
  calculateTool,
  searchWebTool,
  getTimeTool,
  listFilesTool,
  translateTool,
  summarizeTool,
  sendEmailTool,
};
