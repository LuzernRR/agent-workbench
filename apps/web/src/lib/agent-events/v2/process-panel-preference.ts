const STORAGE_KEY = "agent-workbench:v2-process-open:v1";

type StoredPreferences = {
  readonly version: 1;
  readonly runs: Readonly<Record<string, boolean>>;
};

function emptyPreferences(): StoredPreferences {
  return { version: 1, runs: {} };
}

function storage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readAll(target = storage()): StoredPreferences {
  if (!target) return emptyPreferences();
  try {
    const value = target.getItem(STORAGE_KEY);
    if (!value) return emptyPreferences();
    const parsed = JSON.parse(value) as Partial<StoredPreferences>;
    if (parsed.version !== 1 || !parsed.runs || typeof parsed.runs !== "object") {
      return emptyPreferences();
    }
    const runs = Object.fromEntries(
      Object.entries(parsed.runs).filter((entry): entry is [string, boolean] =>
        typeof entry[1] === "boolean"
      )
    );
    return { version: 1, runs };
  } catch {
    return emptyPreferences();
  }
}

export function readV2ProcessOpenPreference(runId: string) {
  return readAll().runs[runId] ?? null;
}

export function writeV2ProcessOpenPreference(runId: string, open: boolean) {
  const target = storage();
  if (!target) return;
  const current = readAll(target);
  try {
    target.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      runs: { ...current.runs, [runId]: open }
    } satisfies StoredPreferences));
  } catch {
    // The current component state remains authoritative when persistence is unavailable.
  }
}
