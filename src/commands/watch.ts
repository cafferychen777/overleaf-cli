import { SyncEngine } from '../sync/engine';
import { loadSyncIgnore } from '../sync/watcher';
import { logger } from '../utils/logger';
import { loadProjectContext } from '../project-context';

export async function watchProject(localDir: string) {
    const {localDir: resolvedDir, projectConfig, identity} = loadProjectContext(localDir);
    const extraIgnore = loadSyncIgnore(resolvedDir);

    const engine = new SyncEngine({
        serverUrl: projectConfig.serverUrl,
        projectId: projectConfig.projectId,
        localDir: resolvedDir,
        identity,
        ignorePatterns: extraIgnore,
    });

    engine.onStatusChange((status) => {
        logger.info(`Sync status: ${status}`);
    });

    await engine.start();

    // Keep the process running
    logger.info('Press Ctrl+C to stop.');

    return new Promise<void>((resolve, reject) => {
        let shuttingDown = false;
        const shutdown = async () => {
            if (shuttingDown) { return; }
            shuttingDown = true;
            process.off('SIGINT', shutdown);
            process.off('SIGTERM', shutdown);
            try {
                await engine.stop();
                resolve();
            } catch (error) {
                reject(error);
            }
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    });
}
