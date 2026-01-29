// Utility functions for siglum-engine

/**
 * Create a batched logger that collects messages and flushes them once per animation frame.
 * This prevents DOM thrashing when the compiler emits many log messages rapidly.
 *
 * @param {function(string[]): void} onFlush - Called with array of messages to display
 * @returns {function(string): void} - Logger function to pass to SiglumCompiler's onLog option
 *
 * @example
 * const compiler = new SiglumCompiler({
 *     onLog: createBatchedLogger((messages) => {
 *         statusDiv.textContent += messages.join('\n') + '\n';
 *         statusDiv.scrollTop = statusDiv.scrollHeight;
 *     }),
 * });
 */
export function createBatchedLogger(onFlush) {
    let buffer = [];
    let flushScheduled = false;

    return function log(msg) {
        buffer.push(msg);
        if (!flushScheduled) {
            flushScheduled = true;
            requestAnimationFrame(() => {
                onFlush(buffer);
                buffer = [];
                flushScheduled = false;
            });
        }
    };
}
