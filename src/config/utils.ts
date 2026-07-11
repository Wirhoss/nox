import { mkdir, readdir } from "node:fs/promises";

export async function readConfigFile<T>( filePath: string, defaultConfig: T ): Promise<T> {
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    await mkdir(filePath.substring(0, filePath.lastIndexOf("/")), {
      recursive: true,
    }).catch(() => {});
    await Bun.write(file, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  } else if(file.size === 0) {
    await Bun.write(file, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }

  return JSON.parse(await file.text()) as T;
}

export async function readConfigDirectory<T>( dirPath: string, defaultConfig: T[] ): Promise<T[]> {
  await mkdir(dirPath, { recursive: true }).catch(() => {});

  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const jsonFiles = entries
    .filter(dirent => dirent.isFile() && dirent.name.endsWith(".json"))
    .map(dirent => `${dirPath}/${dirent.name}`);

  const results: T[] = [];
  for (const filePath of jsonFiles) {
    const content = await Bun.file(filePath).text().catch(() => null);
    if (content && content.trim().length > 0) {
      const parsed = JSON.parse(content);
      results.push(parsed);
    }
  }

  return results.length > 0 ? results : defaultConfig;
}