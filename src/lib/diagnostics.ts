export type DiagnosticValue = string | number | boolean | null;

export interface FrontendDiagnosticRecord {
  requestId: string;
  phase: string;
  at: number;
  [key: string]: DiagnosticValue;
}

const DIAGNOSTIC_STORAGE_KEY = "ollmin:diagnostics";
const DIAGNOSTIC_GLOBAL_KEY = "__OLLMIN_DIAGNOSTICS__";
const MAX_RECORDS = 2000;

type DiagnosticGlobal = typeof globalThis & {
  [DIAGNOSTIC_GLOBAL_KEY]?: FrontendDiagnosticRecord[];
};

function readStorageOverride(): boolean | null {
  try {
    const value = globalThis.localStorage?.getItem(DIAGNOSTIC_STORAGE_KEY);
    if (value === "1" || value === "true" || value === "on") return true;
    if (value === "0" || value === "false" || value === "off") return false;
  } catch {
    // Some WebView contexts expose localStorage but disallow access.
  }
  return null;
}

/**
 * Dev builds collect diagnostics by default. Release builds stay quiet unless
 * the user explicitly sets localStorage['ollmin:diagnostics'] to '1'.
 */
export function diagnosticsEnabled(): boolean {
  const override = readStorageOverride();
  if (override !== null) return override;
  return import.meta.env.DEV;
}

export function recordDiagnostic(
  requestId: string,
  phase: string,
  details: Record<string, DiagnosticValue> = {},
): void {
  if (!diagnosticsEnabled()) return;

  const record: FrontendDiagnosticRecord = {
    requestId,
    phase,
    at: performance.now(),
    ...details,
  };
  const target = globalThis as DiagnosticGlobal;
  const records = target[DIAGNOSTIC_GLOBAL_KEY] ?? [];
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  target[DIAGNOSTIC_GLOBAL_KEY] = records;
  console.debug("[ollmin:diagnostic]", record);
}

export function scheduleDiagnosticPaint(
  requestId: string,
  phase: string,
  details: Record<string, DiagnosticValue> = {},
): void {
  if (!diagnosticsEnabled()) return;
  const callback = () => recordDiagnostic(requestId, phase, details);
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(callback);
  } else {
    globalThis.setTimeout(callback, 16);
  }
}

export function installLongTaskObserver(): () => void {
  if (!diagnosticsEnabled() || typeof PerformanceObserver === "undefined") return () => {};

  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordDiagnostic("global", "long-task", {
          durationMs: Number(entry.duration.toFixed(2)),
          startMs: Number(entry.startTime.toFixed(2)),
        });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // The WebView may not implement the longtask entry type.
    observer?.disconnect();
    observer = undefined;
  }

  return () => observer?.disconnect();
}
