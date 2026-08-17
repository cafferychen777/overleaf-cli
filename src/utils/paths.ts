import * as path from 'path';
import * as fs from 'fs';

export function normalizeServerUrl(input: string): string {
    const value = input.trim();
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`Invalid server URL: ${input}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Server URL must use http or https: ${input}`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`Server URL must not contain credentials, a query, or a fragment: ${input}`);
    }

    parsed.pathname = parsed.pathname.replace(/\/+$/g, '') || '/';
    return parsed.toString().replace(/\/$/g, '');
}

export function normalizeProjectPath(input: string): string {
    if (input.includes('\0')) {
        throw new Error('Project path must not contain a NUL byte.');
    }

    const normalized = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) { return ''; }

    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Unsafe project path: ${input}`);
    }
    return segments.join('/');
}

export function sanitizeFileName(input: string, fallback: string = 'project'): string {
    const sanitized = input
        .normalize('NFC')
        .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
        .trim();
    if (!sanitized || sanitized === '.' || sanitized === '..') { return fallback; }
    return sanitized;
}

export function resolveProjectPath(baseDir: string, projectPath: string): string {
    const base = path.resolve(baseDir);
    const relative = normalizeProjectPath(projectPath);
    const target = relative
        ? path.resolve(base, ...relative.split('/'))
        : base;

    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error(`Project path escapes the local directory: ${projectPath}`);
    }

    let current = base;
    for (const segment of relative.split('/').filter(Boolean)) {
        current = path.join(current, segment);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) {
                throw new Error(`Project path crosses a symbolic link: ${projectPath}`);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { break; }
            throw error;
        }
    }
    return target;
}
