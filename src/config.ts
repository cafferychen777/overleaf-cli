import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Identity } from './api/types';
import { normalizeProjectPath, normalizeServerUrl } from './utils/paths';

const CONFIG_DIR = path.join(os.homedir(), '.overleaf-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface ServerConfig {
    cookies: string;
    csrfToken: string;
    userId?: string;
    userEmail?: string;
}

export interface GlobalConfig {
    servers: {[url: string]: ServerConfig};
}

export interface ProjectConfig {
    serverUrl: string;
    projectId: string;
    projectName: string;
}

function ensureConfigDir() {
    fs.mkdirSync(CONFIG_DIR, {recursive: true, mode: 0o700});
    if (process.platform !== 'win32') {
        fs.chmodSync(CONFIG_DIR, 0o700);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(record, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function parseServerConfig(value: unknown): ServerConfig | null {
    if (!isRecord(value) || typeof value.cookies !== 'string' || typeof value.csrfToken !== 'string') {
        return null;
    }
    return {
        cookies: value.cookies,
        csrfToken: value.csrfToken,
        userId: typeof value.userId === 'string' ? value.userId : undefined,
        userEmail: typeof value.userEmail === 'string' ? value.userEmail : undefined,
    };
}

function parseGlobalConfig(value: unknown): GlobalConfig | null {
    if (!isRecord(value) || !isRecord(value.servers)) { return null; }
    const servers: GlobalConfig['servers'] = {};
    for (const [serverUrl, serverValue] of Object.entries(value.servers)) {
        const server = parseServerConfig(serverValue);
        if (!server) { return null; }
        let normalizedUrl: string;
        try { normalizedUrl = normalizeServerUrl(serverUrl); }
        catch { return null; }
        setOwnRecordValue(servers, normalizedUrl, server);
    }
    return {servers};
}

function parseProjectConfig(value: unknown): ProjectConfig | null {
    if (!isRecord(value)
        || typeof value.serverUrl !== 'string'
        || typeof value.projectId !== 'string'
        || typeof value.projectName !== 'string'
        || !value.projectId.trim()) {
        return null;
    }
    return {
        serverUrl: normalizeServerUrl(value.serverUrl),
        projectId: value.projectId,
        projectName: value.projectName,
    };
}

function writeJsonAtomic(filePath: string, value: unknown, mode?: number): void {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
            encoding: 'utf-8',
            mode,
        });
        fs.renameSync(temporaryPath, filePath);
        if (mode !== undefined) {
            fs.chmodSync(filePath, mode);
        }
    } catch (error) {
        try { fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
        throw error;
    }
}

export function loadGlobalConfig(): GlobalConfig {
    ensureConfigDir();
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const parsed = parseGlobalConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
            if (!parsed) { throw new Error('invalid config shape'); }
            fs.chmodSync(CONFIG_FILE, 0o600);
            return parsed;
        } catch {
            throw new Error(`Config file corrupted: ${CONFIG_FILE}. Delete it and re-login.`);
        }
    }
    return {servers: {}};
}

export function saveGlobalConfig(config: GlobalConfig) {
    ensureConfigDir();
    writeJsonAtomic(CONFIG_FILE, config, 0o600);
}

export function getServerIdentity(serverUrl: string): Identity | null {
    const config = loadGlobalConfig();
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const server = config.servers[normalizedUrl] ?? Object.entries(config.servers)
        .find(([savedUrl]) => {
            try { return normalizeServerUrl(savedUrl) === normalizedUrl; }
            catch { return false; }
        })?.[1];
    if (server) {
        return {cookies: server.cookies, csrfToken: server.csrfToken};
    }
    return null;
}

export function saveServerIdentity(serverUrl: string, identity: Identity, userInfo?: {userId: string; userEmail: string}) {
    const config = loadGlobalConfig();
    const normalizedUrl = normalizeServerUrl(serverUrl);
    for (const savedUrl of Object.keys(config.servers)) {
        try {
            if (savedUrl !== normalizedUrl && normalizeServerUrl(savedUrl) === normalizedUrl) {
                delete config.servers[savedUrl];
            }
        } catch {
            // Keep unrelated legacy entries untouched.
        }
    }
    config.servers[normalizedUrl] = {
        cookies: identity.cookies,
        csrfToken: identity.csrfToken,
        userId: userInfo?.userId,
        userEmail: userInfo?.userEmail,
    };
    saveGlobalConfig(config);
}

const PROJECT_CONFIG_FILE = '.overleaf-cli.json';

export function loadProjectConfig(localDir: string): ProjectConfig | null {
    const configPath = path.join(localDir, PROJECT_CONFIG_FILE);
    if (fs.existsSync(configPath)) {
        try {
            const parsed = parseProjectConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')));
            if (!parsed) { throw new Error('invalid project config shape'); }
            return parsed;
        } catch {
            throw new Error(`Project config corrupted: ${configPath}. Delete it and re-pull.`);
        }
    }
    return null;
}

export function saveProjectConfig(localDir: string, config: ProjectConfig) {
    const configPath = path.join(localDir, PROJECT_CONFIG_FILE);
    const normalizedConfig: ProjectConfig = {
        ...config,
        serverUrl: normalizeServerUrl(config.serverUrl),
    };
    writeJsonAtomic(configPath, normalizedConfig);
}

// --- Binary file hash tracking (for push change detection) ---

const HASHES_FILE = '.overleaf-cli-hashes.json';
const TRACKED_PATHS_FILE = '.overleaf-cli-tracked.json';

export function hashBuffer(content: Buffer | Uint8Array): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

export function loadFileHashes(localDir: string): Record<string, string> {
    const hashPath = path.join(localDir, HASHES_FILE);
    if (fs.existsSync(hashPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(hashPath, 'utf-8'));
            if (!isRecord(raw)) { return {}; }
            const hashes: Record<string, string> = {};
            for (const [projectPath, hash] of Object.entries(raw)) {
                if (typeof hash !== 'string') { continue; }
                try {
                    const normalizedPath = normalizeProjectPath(projectPath);
                    if (normalizedPath) { setOwnRecordValue(hashes, normalizedPath, hash); }
                } catch {
                    // Ignore unsafe legacy state entries.
                }
            }
            return hashes;
        }
        catch { return {}; }
    }
    return {};
}

export function saveFileHashes(localDir: string, hashes: Record<string, string>): void {
    const hashPath = path.join(localDir, HASHES_FILE);
    const cleaned: Record<string, string> = {};
    for (const [projectPath, hash] of Object.entries(hashes)) {
        if (typeof hash !== 'string') { continue; }
        try {
            const normalizedPath = normalizeProjectPath(projectPath);
            if (normalizedPath) { setOwnRecordValue(cleaned, normalizedPath, hash); }
        } catch {
            // Ignore unsafe legacy state entries.
        }
    }
    writeJsonAtomic(hashPath, cleaned);
}

export function loadTrackedPaths(localDir: string): string[] {
    const trackedPath = path.join(localDir, TRACKED_PATHS_FILE);
    if (!fs.existsSync(trackedPath)) { return []; }
    try {
        const raw = JSON.parse(fs.readFileSync(trackedPath, 'utf-8'));
        if (!Array.isArray(raw)) { return []; }
        const cleaned = raw
            .filter((p): p is string => typeof p === 'string' && p.length > 0)
            .flatMap((p) => {
                try { return [normalizeProjectPath(p)]; }
                catch { return []; }
            })
            .filter(Boolean);
        return Array.from(new Set(cleaned)).sort();
    } catch {
        return [];
    }
}

export function saveTrackedPaths(localDir: string, trackedPaths: string[]): void {
    const trackedPath = path.join(localDir, TRACKED_PATHS_FILE);
    const cleaned = Array.from(new Set(
        trackedPaths
            .filter((p) => p.length > 0)
            .map((p) => normalizeProjectPath(p))
    )).sort();
    writeJsonAtomic(trackedPath, cleaned);
}
