const colorEnabled = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

function color(code: string): string {
    return colorEnabled ? code : '';
}

export const colors = {
    red: color('\x1b[31m'),
    green: color('\x1b[32m'),
    cyan: color('\x1b[36m'),
    dim: color('\x1b[2m'),
    bold: color('\x1b[1m'),
    reset: color('\x1b[0m'),
};
