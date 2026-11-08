import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Every adapter must resolve the same location, even when DSH loads a bundle.
export function runtimeRoot() {
  return resolve(process.env.BLACKBOARD_DATA ?? join(homedir(), '.local', 'share', 'blackboard-orchestrator'));
}
