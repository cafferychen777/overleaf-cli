/**
 * Anti-echo debounce for bidirectional sync.
 * Adapted from localReplicaSCM.ts (lines 168-206).
 */
import * as crypto from 'crypto';

type FileCache = {date: number; hash: string};
type SyncContent = string | Uint8Array;
type SuppressScope = 'self' | 'tree';
const ECHO_WINDOW_MS = 2000;

function hashContent(content?: SyncContent): string {
    if (content === undefined) { return 'missing'; }
    return crypto.createHash('sha256')
        .update(typeof content === 'string' ? Buffer.from(content, 'utf-8') : content)
        .digest('hex');
}

export class DebounceManager {
    private bypassCache: Map<string, [FileCache, FileCache]> = new Map();
    private suppressPaths: Map<string, {expireAt: number; scope: SuppressScope}> = new Map();

    private normalizeRelPath(relPath: string): string {
        if (relPath.length <= 1) { return relPath; }
        return relPath.replace(/\/+$/g, '');
    }

    suppressPath(relPath: string, ttlMs: number = 2000, scope: SuppressScope = 'tree') {
        this.suppressPaths.set(this.normalizeRelPath(relPath), {expireAt: Date.now() + ttlMs, scope});
    }

    private isSuppressed(relPath: string): boolean {
        const normalized = this.normalizeRelPath(relPath);
        const now = Date.now();
        let matched = false;
        for (const [p, spec] of this.suppressPaths) {
            if (spec.expireAt <= now) {
                this.suppressPaths.delete(p);
                continue;
            }
            if (spec.scope === 'self') {
                if (normalized === p) {
                    matched = true;
                }
                continue;
            }
            const prefix = p.endsWith('/') ? p : p + '/';
            if (normalized === p || normalized.startsWith(prefix)) {
                matched = true;
            }
        }
        return matched;
    }

    setBypassCache(relPath: string, content?: SyncContent, action?: 'push' | 'pull') {
        const date = Date.now();
        const hash = hashContent(content);
        const cache = this.bypassCache.get(relPath) || [undefined, undefined];

        if (action === 'push') {
            cache[0] = {date, hash};
            cache[1] = cache[1] ?? {date, hash};
        } else if (action === 'pull') {
            cache[1] = {date, hash};
            cache[0] = cache[0] ?? {date, hash};
        } else {
            cache[0] = {date, hash};
            cache[1] = {date, hash};
        }
        this.bypassCache.set(relPath, cache as [FileCache, FileCache]);
    }

    shouldPropagate(action: 'push' | 'pull', relPath: string, content?: SyncContent): boolean {
        if (this.isSuppressed(relPath)) { return false; }

        const now = Date.now();
        const cache = this.bypassCache.get(relPath);
        if (cache) {
            const thisHash = hashContent(content);
            if (action === 'push') {
                // duplicate local event
                if (cache[0].hash === thisHash) { return false; }
                // immediate echo of just-pulled content
                if (cache[1].hash === thisHash && now - cache[1].date < ECHO_WINDOW_MS) { return false; }
            } else {
                // duplicate remote event
                if (cache[1].hash === thisHash) { return false; }
                // immediate echo of just-pushed content
                if (cache[0].hash === thisHash && now - cache[0].date < ECHO_WINDOW_MS) { return false; }
            }
        }
        this.setBypassCache(relPath, content, action);
        return true;
    }

    invalidate(relPath: string) {
        this.bypassCache.delete(relPath);
    }

    clear() {
        this.bypassCache.clear();
    }
}
