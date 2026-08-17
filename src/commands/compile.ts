import * as fs from 'fs';
import { OutputFileEntity } from '../api/types';
import { logger } from '../utils/logger';
import { loadProjectContext } from '../project-context';
import { resolveProjectPath } from '../utils/paths';

export type Compiler = 'pdflatex' | 'xelatex' | 'lualatex';

export function parseCompiler(input: string): Compiler {
    const compiler = input.trim().toLowerCase();
    if (compiler === 'pdflatex' || compiler === 'xelatex' || compiler === 'lualatex') {
        return compiler;
    }
    throw new Error(`Invalid compiler "${input}". Use pdflatex, xelatex, or lualatex.`);
}

function selectPrimaryOutputFile(outputFiles: OutputFileEntity[], type: string): OutputFileEntity | undefined {
    const typedFiles = outputFiles.filter((file) => file.type === type);
    if (typedFiles.length === 0) {
        return undefined;
    }

    const canonicalPath = `output.${type}`;
    const canonicalFile = typedFiles.find((file) => {
        const normalizedPath = file.path.replace(/^\.?\//, '');
        return normalizedPath === canonicalPath || normalizedPath.endsWith(`/${canonicalPath}`);
    });
    if (canonicalFile) {
        return canonicalFile;
    }

    if (typedFiles.length === 1) {
        return typedFiles[0];
    }

    return undefined;
}

export function selectPrimaryPdfOutput(outputFiles: OutputFileEntity[]): OutputFileEntity | undefined {
    return selectPrimaryOutputFile(outputFiles, 'pdf');
}

export function selectPrimaryLogOutput(outputFiles: OutputFileEntity[]): OutputFileEntity | undefined {
    return selectPrimaryOutputFile(outputFiles, 'log');
}

export async function compileProject(localDir: string, compiler?: Compiler) {
    const {localDir: resolvedDir, projectConfig, identity, api} = loadProjectContext(localDir);

    logger.info('Triggering compilation...');
    const res = await api.compile(identity, projectConfig.projectId, null, false, false, compiler);

    if (res.type !== 'success' || !res.compile) {
        throw new Error(res.message || 'Compilation request failed');
    }

    const compile = res.compile;
    logger.info(`Compile status: ${compile.status}`);

    if (compile.status !== 'success') {
        // Download log for diagnostics
        const logOutput = selectPrimaryLogOutput(compile.outputFiles);
        if (logOutput) {
            const logRes = await api.getFileFromClsi(
                identity,
                logOutput.url,
                compile.compileGroup,
                compile.clsiServerId,
            );
            if (logRes.type === 'success' && logRes.content) {
                const logPath = resolveProjectPath(resolvedDir, 'output.log');
                fs.writeFileSync(logPath, logRes.content);
                throw new Error(`Compilation failed (${compile.status}). Log saved to ${logPath}`);
            }
        }
        throw new Error(`Compilation failed: ${compile.status}`);
    }

    const pdfOutput = selectPrimaryPdfOutput(compile.outputFiles);
    if (!pdfOutput) {
        const availablePdfOutputs = compile.outputFiles
            .filter((f) => f.type === 'pdf')
            .map((f) => f.path)
            .join(', ');
        throw new Error(
            availablePdfOutputs.length > 0
                ? `Compilation succeeded but the primary PDF output was not identified. Available PDF outputs: ${availablePdfOutputs}`
                : 'Compilation succeeded but no PDF output found'
        );
    }

    logger.info('Downloading PDF...');
    const pdfRes = await api.getFileFromClsi(
        identity,
        pdfOutput.url,
        compile.compileGroup,
        compile.clsiServerId,
    );
    if (pdfRes.type !== 'success' || !pdfRes.content) {
        throw new Error('Failed to download compiled PDF');
    }

    const pdfPath = resolveProjectPath(resolvedDir, 'output.pdf');
    fs.writeFileSync(pdfPath, pdfRes.content);
    logger.info(`PDF saved to ${pdfPath}`);
    return pdfPath;
}
