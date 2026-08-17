export function decodeSocketText(text: string): string {
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0xff) { return text; }
    }

    const decoded = Buffer.from(text, 'latin1').toString('utf-8');
    return decoded.includes('\ufffd') ? text : decoded;
}
