import { mkdir } from "node:fs/promises";

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