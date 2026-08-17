import {
    ProjectHistoryFileDiffSchema,
    ProjectHistoryTreeDiffChange,
    ProjectHistoryUpdate,
    RestoredHistoryFileEntity,
} from '../api/types';

export function parseHistoryLimit(value: string): number {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error('History limit must be a positive integer.');
    }
    if (limit > 1000) {
        throw new Error('History limit must not exceed 1000.');
    }
    return limit;
}

export function formatHistoryTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

export function collectHistoryPaths(update: ProjectHistoryUpdate): string[] {
    const paths = new Set<string>();
    for (const pathname of update.pathnames) {
        paths.add(pathname);
    }
    for (const op of update.project_ops) {
        if (op.add?.pathname) { paths.add(op.add.pathname); }
        if (op.remove?.pathname) { paths.add(op.remove.pathname); }
    }
    return Array.from(paths).sort();
}

export function summarizeHistoryPaths(update: ProjectHistoryUpdate, maxPaths: number = 3): string {
    const paths = collectHistoryPaths(update);
    if (paths.length === 0) {
        return 'no file paths recorded';
    }

    const visible = paths.slice(0, maxPaths);
    const suffix = paths.length > maxPaths ? ` (+${paths.length - maxPaths} more)` : '';
    return `${visible.join(', ')}${suffix}`;
}

export function summarizeHistoryUsers(update: ProjectHistoryUpdate): string {
    const users = update.meta.users.map((user) => `${user.first_name}${user.last_name ? ` ${user.last_name}` : ''}`.trim());
    return users.length > 0 ? users.join(', ') : 'unknown user';
}

export function extractHistoryFileContent(diff: ProjectHistoryFileDiffSchema): string | undefined {
    for (const chunk of diff.diff) {
        if (typeof chunk.u === 'string') {
            return chunk.u;
        }
    }
    return undefined;
}

export function filterChangedTreeEntries(entries: ProjectHistoryTreeDiffChange[]): ProjectHistoryTreeDiffChange[] {
    return entries.filter((entry) => Boolean(entry.operation));
}

export function formatTreeDiffEntry(entry: ProjectHistoryTreeDiffChange): string {
    if (entry.operation === 'renamed') {
        return `renamed  ${entry.pathname} -> ${entry.newPathname || entry.pathname}`;
    }
    return `${(entry.operation || 'changed').padEnd(7, ' ')} ${entry.pathname}`;
}

export function formatRestoredHistoryFileResult(
    restored: RestoredHistoryFileEntity,
    restoredPath?: string,
): string {
    if (restoredPath) {
        return `Restored file created on Overleaf: ${restoredPath}`;
    }
    return `Restored file created on Overleaf: ${restored.id}`;
}
