import * as fs from 'fs';
import * as path from 'path';
import { hashBuffer } from '../config';
import { shouldIgnore, shouldTreatAsText } from './watcher';

export interface LocalSyncSnapshot {
    trackedPaths: string[];
    binaryHashes: Record<string, string>;
}

export function collectLocalSyncSnapshot(baseDir: string, extraIgnore: string[]): LocalSyncSnapshot {
    const trackedPaths = new Set<string>();
    const binaryHashes: Record<string, string> = {};

    const walk = (currentDir: string): void => {
        for (const entry of fs.readdirSync(currentDir, {withFileTypes: true})) {
            const fullPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(baseDir, fullPath).split(path.sep).join('/');
            if (!relativePath || shouldIgnore(relativePath, extraIgnore)) { continue; }

            if (entry.isDirectory()) {
                trackedPaths.add(relativePath);
                walk(fullPath);
            } else if (entry.isFile()) {
                trackedPaths.add(relativePath);
                const content = fs.readFileSync(fullPath);
                if (!shouldTreatAsText(entry.name, content)) {
                    binaryHashes[relativePath] = hashBuffer(content);
                }
            }
        }
    };

    walk(baseDir);
    return {
        trackedPaths: Array.from(trackedPaths).sort(),
        binaryHashes,
    };
}
