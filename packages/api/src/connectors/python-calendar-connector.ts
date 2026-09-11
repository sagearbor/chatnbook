// Production CalendarConnector: shells out to the Python connectors
// package (packages/connectors-py) via a small JSON-over-stdio CLI bridge
// (packages/connectors-py/src/connectors/cli.py). This keeps the
// Google/Microsoft/ICS calendar logic in one place (Python, already
// tested in packages/connectors-py/tests) instead of re-implementing it
// in TypeScript.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  CalendarConnector,
  GetBusyParams,
  CreateEventParams,
  DeleteEventParams,
  ComputeAvailabilityParams,
  BusyInterval,
  AvailabilitySlot,
} from './calendar-connector.js';
import { ConnectorError } from './calendar-connector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, computed relative to wherever the API package actually runs
 * from (packages/api), regardless of whether this file is running via
 * ts-node from src/ or compiled to dist/api/src/connectors/. */
function findRepoRoot(): string {
  if (process.env.CONNECTORS_PY_SRC) {
    // Caller supplied the connectors-py src dir directly; no search needed.
    return '';
  }
  // Walk up from this file until we find packages/connectors-py.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'packages', 'connectors-py', 'src');
    if (fs.existsSync(candidate)) return dir;
    dir = path.dirname(dir);
  }
  // Fall back to cwd-relative (works when cwd is packages/api, the normal
  // case for `pnpm --filter @smb/api dev|test`).
  return path.resolve(process.cwd(), '..', '..');
}

function connectorsPySrcDir(): string {
  if (process.env.CONNECTORS_PY_SRC) return process.env.CONNECTORS_PY_SRC;
  return path.join(findRepoRoot(), 'packages', 'connectors-py', 'src');
}

function pythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython = path.join(findRepoRoot(), '.venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
}

interface CliResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

function runCli<T>(request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ['-m', 'connectors.cli'], {
      cwd: connectorsPySrcDir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (err) => {
      reject(new ConnectorError(`failed to spawn python connector: ${err.message}`));
    });

    child.on('close', () => {
      let parsed: CliResponse<T>;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(
          new ConnectorError(
            `python connector produced invalid output (stderr: ${stderr.trim() || '<empty>'}, stdout: ${stdout.trim()})`
          )
        );
        return;
      }
      if (!parsed.ok) {
        reject(new ConnectorError(parsed.error || 'unknown connector error'));
        return;
      }
      resolve(parsed.result as T);
    });

    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

export class PythonCalendarConnector implements CalendarConnector {
  async getBusy(params: GetBusyParams): Promise<BusyInterval[]> {
    const result = await runCli<{ busy: [string, string][] }>({ action: 'get_busy', ...params });
    return result.busy.map(([start, end]) => ({ start, end }));
  }

  async createEvent(params: CreateEventParams): Promise<{ eventId: string }> {
    return runCli<{ eventId: string }>({ action: 'create_event', ...params });
  }

  async deleteEvent(params: DeleteEventParams): Promise<void> {
    await runCli<Record<string, never>>({ action: 'delete_event', ...params });
  }

  async computeAvailability(params: ComputeAvailabilityParams): Promise<AvailabilitySlot[]> {
    const result = await runCli<{ slots: [string, string][] }>({
      action: 'compute_availability',
      start: params.start,
      end: params.end,
      slotMinutes: params.slotMinutes,
      busy: params.busy.map((b) => [b.start, b.end]),
    });
    return result.slots.map(([start, end]) => ({ start, end }));
  }
}
