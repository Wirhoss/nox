import type { Tool, ToolResponse } from "../types";

/**
 * Hardcoded test tools for agent experimentation.
 */

function asText(result: unknown): ToolResponse {
  return [{ type: "text", text: JSON.stringify(result) }];
}

const getWeatherTool: Tool = {
  name: "get_weather",
  description: "Get the current weather for a given location",
  parameters: {
    city: {
      type: "string",
      description: "The city name to get weather for",
      isRequired: true,
    },
    unit: {
      type: "string",
      description: "Temperature unit",
      enum: ["celsius", "fahrenheit"],
      isRequired: false,
    },
  },
  call: async (params: Record<string, any>) => {
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
      temperature: temp[unit as "celsius" | "fahrenheit"],
      unit,
      condition: conditions[Math.floor(Math.random() * conditions.length)],
      humidity: Math.floor(Math.random() * 60) + 30,
    });
  },
};

const calculateTool: Tool = {
  name: "calculate",
  description: "Perform a mathematical calculation",
  parameters: {
    expression: {
      type: "string",
      description: "The mathematical expression to evaluate (e.g. '2 + 3 * 4')",
      isRequired: true,
    },
  },
  call: async (params: Record<string, any>) => {
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

const searchWebTool: Tool = {
  name: "search_web",
  description: "Search the web for information",
  parameters: {
    query: {
      type: "string",
      description: "The search query string",
      isRequired: true,
    },
    maxResults: {
      type: "number",
      description: "Maximum number of results to return",
      isRequired: false,
    },
  },
  call: async (params: Record<string, any>) => {
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

const getTimeTool: Tool = {
  name: "get_time",
  description: "Get the current date and time in a specific timezone",
  parameters: {
    timezone: {
      type: "string",
      description: "The IANA timezone (e.g. 'America/New_York', 'Europe/London')",
      isRequired: false,
    },
  },
  call: async (params: Record<string, any>) => {
    const timezone = params.timezone || "UTC";
    const now = new Date();
    const formatted = now.toLocaleString("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "medium" });
    return asText({ timezone, datetime: now.toISOString(), formatted });
  },
};

const listFilesTool: Tool = {
  name: "list_files",
  description: "List files in a directory",
  parameters: {
    path: {
      type: "string",
      description: "The directory path to list",
      isRequired: true,
    },
    recursive: {
      type: "boolean",
      description: "Whether to list files recursively",
      isRequired: false,
    },
  },
  call: async (params: Record<string, any>) => {
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

const translateTool: Tool = {
  name: "translate",
  description: "Translate text from one language to another",
  parameters: {
    text: {
      type: "string",
      description: "The text to translate",
      isRequired: true,
    },
    sourceLang: {
      type: "string",
      description: "Source language code (e.g. 'en', 'es', 'fr')",
      isRequired: false,
    },
    targetLang: {
      type: "string",
      description: "Target language code (e.g. 'en', 'es', 'fr')",
      isRequired: true,
    },
  },
  call: async (params: Record<string, any>) => {
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

const summarizeTool: Tool = {
  name: "summarize",
  description: "Summarize a piece of text",
  parameters: {
    text: {
      type: "string",
      description: "The text to summarize",
      isRequired: true,
    },
    maxLength: {
      type: "number",
      description: "Maximum length of the summary in words",
      isRequired: false,
    },
  },
  call: async (params: Record<string, any>) => {
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

const sendEmailTool: Tool = {
  name: "send_email",
  description: "Send an email to a recipient",
  parameters: {
    to: {
      type: "string",
      description: "Recipient email address",
      isRequired: true,
    },
    subject: {
      type: "string",
      description: "Email subject line",
      isRequired: true,
    },
    body: {
      type: "string",
      description: "Email body content",
      isRequired: true,
    },
    cc: {
      type: "array",
      items: {
        type: "string",
        description: "An email address to CC",
        isRequired: false,
      },
      description: "List of CC recipients",
      isRequired: false,
    },
  },
  call: async (params: Record<string, any>) => {
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
