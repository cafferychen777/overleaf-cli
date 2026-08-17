import * as path from 'path';
import * as fs from 'fs';
import { SocketIOAPI } from '../api/socketio';
import { RemoteTree } from '../sync/remote-tree';
import { hashBuffer } from '../config';
import { loadProjectContext } from '../project-context';
import { shouldIgnore, loadSyncIgnore } from '../sync/watcher';
import { logger } from '../utils/logger';
import { renderUnifiedDiff } from '../utils/unified-diff';
import { normalizeProjectPath, resolveProjectPath } from '../utils/paths';
import { colors } from '../utils/colors';

const {red: RED, green: GREEN, cyan: CYAN, dim: DIM, bold: BOLD, reset: RESET} = colors;

interface DiffEntry {
    path: string;
    status: 'modified' | 'local-only' | 'remote-only' | 'binary-modified' | 'type-conflict';
    localContent?: string;
    remoteContent?: string;
}

export async function diffProject(localDir: string) {
    const {localDir: resolvedDir, projectConfig, identity, api} = loadProjectContext(localDir);
    let socket: SocketIOAPI | undefined;

    try {
        socket = new SocketIOAPI(api, identity, projectConfig.projectId);
        const tree = new RemoteTree();
        const project = await socket.joinProject();
        tree.setProject(project);

        const extraIgnore = loadSyncIgnore(resolvedDir);
        const entries: DiffEntry[] = [];

        // Track remote paths we've visited (to find local-only files later)
        const remotePaths = new Set<string>();

        // Walk remote tree
        const allEntities = tree.walk(() => true);
        for (const { entity, path: entityPath } of allEntities) {
            if (entity._type === 'folder') { continue; }

            const relPath = normalizeProjectPath(entityPath);
            if (shouldIgnore(relPath, extraIgnore)) { continue; }
            remotePaths.add(relPath);

            const localPath = resolveProjectPath(resolvedDir, relPath);

            if (entity._type === 'doc') {
                try {
                    const { docLines } = await socket.joinDoc(entity._id);
                    const remoteContent = docLines.join('\n');
                    await socket.leaveDoc(entity._id);

                    if (!fs.existsSync(localPath)) {
                        entries.push({ path: relPath, status: 'remote-only', remoteContent });
                    } else {
                        const stat = fs.lstatSync(localPath);
                        if (!stat.isFile() || stat.isSymbolicLink()) {
                            entries.push({ path: relPath, status: 'type-conflict' });
                            continue;
                        }
                        const localContent = fs.readFileSync(localPath, 'utf-8');
                        if (localContent !== remoteContent) {
                            entries.push({ path: relPath, status: 'modified', localContent, remoteContent });
                        }
                    }
                } catch (err) {
                    logger.error(`Failed to diff doc ${relPath}:`, err);
                }
            } else if (entity._type === 'file') {
                if (!fs.existsSync(localPath)) {
                    entries.push({ path: relPath, status: 'remote-only' });
                } else {
                    // Compare binary by downloading and hashing
                    try {
                        const stat = fs.lstatSync(localPath);
                        if (!stat.isFile() || stat.isSymbolicLink()) {
                            entries.push({ path: relPath, status: 'type-conflict' });
                            continue;
                        }
                        const res = await api.getFile(identity, projectConfig.projectId, entity._id);
                        if (res.type === 'success' && res.content) {
                            const remoteHash = hashBuffer(Buffer.from(res.content));
                            const localHash = hashBuffer(fs.readFileSync(localPath));
                            if (remoteHash !== localHash) {
                                entries.push({ path: relPath, status: 'binary-modified' });
                            }
                        }
                    } catch (err) {
                        logger.error(`Failed to diff binary ${relPath}:`, err);
                    }
                }
            }
        }

        // Find local-only files
        walkLocal(resolvedDir, resolvedDir, extraIgnore, (relPath, isDir) => {
            if (isDir) { return; }
            if (!remotePaths.has(relPath)) {
                entries.push({ path: relPath, status: 'local-only' });
            }
        });

        // Sort entries by path
        entries.sort((a, b) => a.path.localeCompare(b.path));

        if (entries.length === 0) {
            console.log('No differences found. Local and remote are in sync.');
            return;
        }

        // Print results
        for (const entry of entries) {
            switch (entry.status) {
                case 'local-only':
                    console.log(`${GREEN}+ local only:  ${entry.path}${RESET}`);
                    break;
                case 'remote-only':
                    console.log(`${RED}- remote only: ${entry.path}${RESET}`);
                    break;
                case 'binary-modified':
                    console.log(`${CYAN}~ binary changed: ${entry.path}${RESET}`);
                    break;
                case 'type-conflict':
                    console.log(`${RED}! type conflict: ${entry.path}${RESET}`);
                    break;
                case 'modified':
                    console.log(renderUnifiedDiff(entry.path, entry.remoteContent!, entry.localContent!, {
                        oldLabel: 'remote  (Overleaf)',
                        newLabel: 'local',
                    }));
                    break;
            }
        }

        // Summary
        const modified = entries.filter(
            e => e.status === 'modified' || e.status === 'binary-modified' || e.status === 'type-conflict'
        ).length;
        const localOnly = entries.filter(e => e.status === 'local-only').length;
        const remoteOnly = entries.filter(e => e.status === 'remote-only').length;
        console.log(`\n${DIM}---${RESET}`);
        console.log(`${BOLD}${entries.length} difference(s):${RESET} ${modified} modified, ${localOnly} local-only, ${remoteOnly} remote-only`);
    } finally {
        socket?.disconnect();
    }
}

function walkLocal(
    baseDir: string,
    currentDir: string,
    extraIgnore: string[],
    callback: (relPath: string, isDir: boolean) => void,
) {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
        if (shouldIgnore(relPath, extraIgnore)) { continue; }

        if (entry.isDirectory()) {
            callback(relPath, true);
            walkLocal(baseDir, fullPath, extraIgnore, callback);
        } else if (entry.isFile()) {
            callback(relPath, false);
        }
    }
}
