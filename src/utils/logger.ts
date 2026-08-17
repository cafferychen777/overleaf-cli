export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel) {
    currentLevel = level;
}

function timestamp(): string {
    return new Date().toLocaleString();
}

export const logger = {
    debug(...args: any[]) {
        if (currentLevel <= LogLevel.DEBUG) {
            console.error(`[${timestamp()}] [DEBUG]`, ...args);
        }
    },
    info(...args: any[]) {
        if (currentLevel <= LogLevel.INFO) {
            console.error(`[${timestamp()}] [INFO]`, ...args);
        }
    },
    warn(...args: any[]) {
        if (currentLevel <= LogLevel.WARN) {
            console.error(`[${timestamp()}] [WARN]`, ...args);
        }
    },
    error(...args: any[]) {
        if (currentLevel <= LogLevel.ERROR) {
            console.error(`[${timestamp()}] [ERROR]`, ...args);
        }
    },
};
