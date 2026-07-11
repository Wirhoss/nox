function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null &&
    (e as { name?: string }).name === "AbortError";
}
export { isAbortError };