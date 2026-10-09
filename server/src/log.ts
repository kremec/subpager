function line(level: string, message: string): string {
  const clean = message.replace(
    /[\p{Cc}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${new Date().toISOString()} ${level} ${clean.length > 4000 ? `${clean.slice(0, 4000)}…` : clean}`;
}

export function logInfo(message: string): void {
  console.log(line("INFO", message));
}

export function logError(message: string): void {
  console.error(line("ERROR", message));
}

export function createErrorReporter(label: string) {
  let previous: string | null = null;
  let loggedAt = 0;
  return (error: string | null): void => {
    if (error === null) {
      if (previous !== null) logInfo(`${label} recovered`);
      previous = null;
      return;
    }
    const now = Date.now();
    if (error === previous && now - loggedAt < 300_000) {
      return;
    }
    logError(
      `${label}: ${error}${error === previous ? "; still failing" : ""}`,
    );
    previous = error;
    loggedAt = now;
  };
}
