import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { minimatch } from 'minimatch';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export interface WatcherEvents {
    change: (relPath: string) => void;
    add: (relPath: string) => void;
    unlink: (relPath: string) => void;
    addDir: (relPath: string) => void;
    unlinkDir: (relPath: string) => void;
}

export const ignorePatterns = [
    '**/.*',
    '**/.*/**',
    '**/*.aux',
    '**/*.bbl',
    '**/*.bcf',
    '**/*.blg',
    '**/*.fdb_latexmk',
    '**/*.fls',
    '**/*.lof',
    '**/*.log',
    '**/*.lot',
    '**/*.out',
    '**/*.run.xml',
    '**/*.synctex(busy)',
    '**/*.synctex.gz',
    '**/*.toc',
    '**/*.xdv',
    '**/main.pdf',
    '**/output.pdf',
];

const SYNCIGNORE_FILE = '.overleaf-cliignore';
const TEXT_EXTENSIONS = new Set([
    '.bib', '.tex', '.cls', '.sty', '.bst', '.bbx', '.cbx',
    '.dtx', '.ins', '.ltx', '.tikz', '.md', '.txt', '.csv',
    '.tsv', '.yaml', '.yml', '.toml', '.json', '.xml',
]);

function classifyFileByName(fileName: string): 'text' | 'binary' | 'unknown' {
    const ext = path.extname(fileName).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) { return 'text'; }

    const mimeType = require('mime-types').lookup(fileName);
    if (!mimeType) { return 'unknown'; }
    if (mimeType.startsWith('text/') || mimeType === 'application/json'
        || mimeType === 'application/x-tex' || mimeType === 'application/xml') {
        return 'text';
    }
    return 'binary';
}

/** Load project-level ignore patterns from .overleaf-cliignore */
export function loadSyncIgnore(baseDir: string): string[] {
    const ignorePath = path.join(baseDir, SYNCIGNORE_FILE);
    if (!fs.existsSync(ignorePath)) { return []; }
    return fs.readFileSync(ignorePath, 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .map(pattern => {
            // gitignore: trailing '/' means directory
            // '/dir/' → anchored to root: 'dir/**' (leading '/' handled by shouldIgnore)
            // 'dir/'  → any level: '**/dir/**'
            if (pattern.endsWith('/')) {
                if (pattern.startsWith('/')) { return pattern + '**'; }
                return '**/' + pattern + '**';
            }
            return pattern;
        });
}

/** Normalize path: strip leading '/' so pattern matching is consistent across all callers. */
function normalizePath(relPath: string): string {
    return relPath.replace(/^\/+/, '');
}

export function shouldIgnore(relPath: string, extraPatterns?: string[]): boolean {
    const normalized = normalizePath(relPath);
    const allPatterns = extraPatterns ? [...ignorePatterns, ...extraPatterns] : ignorePatterns;
    return allPatterns.some((pattern) => {
        // gitignore semantics:
        // - pattern without '/' (e.g. '*.py'): match against basename
        // - pattern with leading '/' (e.g. '/build/**'): strip '/', match full path
        // - pattern with '/' elsewhere (e.g. 'data/**'): match full path
        let p = pattern;
        let opts: {dot?: boolean; matchBase?: boolean} = {dot: true};

        if (p.startsWith('/')) {
            p = p.slice(1);
        } else if (!p.includes('/')) {
            opts.matchBase = true;
        }

        if (minimatch(normalized, p, opts)) { return true; }
        // 'dir/**' should also match 'dir' itself
        if (p.endsWith('/**') && minimatch(normalized, p.slice(0, -3), opts)) { return true; }
        return false;
    });
}

export function isTextFile(fileName: string): boolean {
    return classifyFileByName(fileName) !== 'binary';
}

/**
 * Heuristic content sniffing for unknown/ambiguous extensions.
 * Binary indicators:
 * - NUL byte
 * - High ratio of control bytes (excluding \t, \n, \r)
 */
export function isLikelyTextContent(content: Uint8Array): boolean {
    if (content.length === 0) { return true; }
    const sample = content.subarray(0, Math.min(content.length, 8192));
    let controlBytes = 0;
    for (const b of sample) {
        if (b === 0) { return false; }
        const isControl = (b < 0x09) || (b > 0x0d && b < 0x20);
        if (isControl) { controlBytes++; }
    }
    if ((controlBytes / sample.length) >= 0.1) { return false; }

    // Invalid UTF-8 bytes should not be treated as text.
    try {
        // TextDecoder is available in supported Node runtimes.
        new TextDecoder('utf-8', {fatal: true}).decode(sample);
        return true;
    } catch {
        return false;
    }
}

export function shouldTreatAsText(fileName: string, content?: Uint8Array): boolean {
    const classified = classifyFileByName(fileName);
    if (classified === 'text') { return true; }
    if (classified === 'binary') { return false; }
    if (!content) { return true; } // preserve backward compatibility for unknown names
    return isLikelyTextContent(content); // disambiguate unknown types with real bytes
}

export class LocalWatcher extends EventEmitter {
    private watcher?: chokidar.FSWatcher;
    private ignorePath: string;
    private baseDir: string;
    private extraPatterns: string[];

    constructor(baseDir: string, extraPatterns?: string[]) {
        super();
        this.baseDir = baseDir;
        this.ignorePath = path.join(baseDir, SYNCIGNORE_FILE);
        this.extraPatterns = extraPatterns || [];
    }

    /** Current extra ignore patterns (updated by hot-reload). */
    get ignorePatterns(): string[] { return this.extraPatterns; }

    private matchIgnore(relPath: string): boolean {
        return shouldIgnore(relPath, this.extraPatterns);
    }

    private toRelPath(absPath: string): string {
        let rel = path.relative(this.baseDir, absPath);
        // normalize to forward slashes
        rel = rel.split(path.sep).join('/');
        return '/' + rel;
    }

    private watchSyncIgnore() {
        // fs.watchFile works even if file doesn't exist yet (polling-based)
        fs.watchFile(this.ignorePath, {interval: 2000}, () => {
            this.extraPatterns = loadSyncIgnore(this.baseDir);
            logger.info(`[watcher] reloaded ${SYNCIGNORE_FILE} (${this.extraPatterns.length} patterns)`);
        });
    }

    start() {
        this.watcher = chokidar.watch(this.baseDir, {
            ignoreInitial: true,
            persistent: true,
            followSymlinks: false,
            ignored: (absPath: string) => this.matchIgnore(this.toRelPath(absPath)),
            awaitWriteFinish: {stabilityThreshold: 300, pollInterval: 100},
        });

        const handle = (event: string) => (absPath: string) => {
            const relPath = this.toRelPath(absPath);
            if (this.matchIgnore(relPath)) { return; }
            logger.debug(`[watcher] ${event} ${relPath}`);
            this.emit(event, relPath);
        };

        this.watcher
            .on('change', handle('change'))
            .on('add', handle('add'))
            .on('unlink', handle('unlink'))
            .on('addDir', handle('addDir'))
            .on('unlinkDir', handle('unlinkDir'))
            .on('error', (err) => logger.error('[watcher] error', err));

        this.watchSyncIgnore();
    }

    async stop() {
        fs.unwatchFile(this.ignorePath);
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = undefined;
        }
    }
}
