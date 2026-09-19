const DEV = import.meta.env.DEV;

/** Development-noisy, production-quiet logging for the Activity lifecycle. */
export function devLog(event: string, detail?: unknown) {
  if (DEV) console.info(`[activity] ${event}`, detail ?? "");
}

export function warnLog(event: string, detail?: unknown) {
  console.warn(`[activity] ${event}`, detail ?? "");
}
