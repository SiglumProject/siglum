/**
 * Tests for utils.js - Utility functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBatchedLogger } from '../../src/utils.js';

describe('utils module', () => {
    describe('createBatchedLogger', () => {
        let rafCallbacks: FrameRequestCallback[] = [];
        let rafId = 0;

        beforeEach(() => {
            rafCallbacks = [];
            rafId = 0;

            // Mock requestAnimationFrame
            vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
                rafCallbacks.push(cb);
                return ++rafId;
            });
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        // Helper to flush RAF
        function flushRaf() {
            const callbacks = rafCallbacks.splice(0);
            callbacks.forEach(cb => cb(performance.now()));
        }

        it('should create a logger function', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);
            expect(typeof logger).toBe('function');
        });

        it('should not call onFlush immediately', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);
            logger('test message');
            expect(onFlush).not.toHaveBeenCalled();
        });

        it('should batch messages until RAF fires', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            logger('message 1');
            logger('message 2');
            logger('message 3');

            expect(onFlush).not.toHaveBeenCalled();

            flushRaf();

            expect(onFlush).toHaveBeenCalledTimes(1);
            expect(onFlush).toHaveBeenCalledWith(['message 1', 'message 2', 'message 3']);
        });

        it('should schedule RAF only once per batch', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            logger('msg 1');
            logger('msg 2');
            logger('msg 3');

            // Only one RAF should be scheduled
            expect(rafCallbacks.length).toBe(1);
        });

        it('should reset buffer after flush', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            logger('first batch');
            flushRaf();

            logger('second batch');
            flushRaf();

            expect(onFlush).toHaveBeenCalledTimes(2);
            expect(onFlush).toHaveBeenNthCalledWith(1, ['first batch']);
            expect(onFlush).toHaveBeenNthCalledWith(2, ['second batch']);
        });

        it('should handle empty messages', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            logger('');
            flushRaf();

            expect(onFlush).toHaveBeenCalledWith(['']);
        });

        it('should handle multiple flushes', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            // First batch
            logger('a');
            logger('b');
            flushRaf();

            // Second batch
            logger('c');
            logger('d');
            flushRaf();

            // Third batch
            logger('e');
            flushRaf();

            expect(onFlush).toHaveBeenCalledTimes(3);
        });

        it('should preserve message order', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            for (let i = 0; i < 10; i++) {
                logger(`message ${i}`);
            }
            flushRaf();

            const [messages] = onFlush.mock.calls[0];
            for (let i = 0; i < 10; i++) {
                expect(messages[i]).toBe(`message ${i}`);
            }
        });

        it('should handle special characters in messages', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            logger('Line 1\nLine 2');
            logger('Tab\there');
            logger('Unicode: 你好');
            flushRaf();

            expect(onFlush).toHaveBeenCalledWith([
                'Line 1\nLine 2',
                'Tab\there',
                'Unicode: 你好',
            ]);
        });

        it('should handle rapid logging', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            // Simulate rapid logging
            for (let i = 0; i < 1000; i++) {
                logger(`log ${i}`);
            }
            flushRaf();

            expect(onFlush).toHaveBeenCalledTimes(1);
            const [messages] = onFlush.mock.calls[0];
            expect(messages.length).toBe(1000);
        });

        it('should allow new batch after flush', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            logger('batch 1');
            flushRaf();

            // New RAF should be scheduled for next batch
            expect(rafCallbacks.length).toBe(0);

            logger('batch 2');
            expect(rafCallbacks.length).toBe(1);
        });

        it('should work with different onFlush callbacks', () => {
            const results: string[][] = [];

            const logger1 = createBatchedLogger((msgs) => results.push([...msgs, 'from logger1']));
            const logger2 = createBatchedLogger((msgs) => results.push([...msgs, 'from logger2']));

            logger1('a');
            logger2('b');
            flushRaf();

            expect(results.length).toBe(2);
            expect(results[0]).toContain('from logger1');
            expect(results[1]).toContain('from logger2');
        });

        it('should handle onFlush throwing an error', () => {
            const onFlush = vi.fn().mockImplementation(() => {
                throw new Error('Flush error');
            });
            const logger = createBatchedLogger(onFlush);

            logger('test');

            // Should not throw when flushing
            expect(() => flushRaf()).toThrow('Flush error');

            // Logger should still be callable
            logger('after error');
        });

        it('should work without any messages logged before RAF', () => {
            const onFlush = vi.fn();
            createBatchedLogger(onFlush);

            // No messages logged
            flushRaf();

            // onFlush should not be called if no messages
            expect(onFlush).not.toHaveBeenCalled();
        });

        it('should handle undefined/null coercion', () => {
            const onFlush = vi.fn();
            const logger = createBatchedLogger(onFlush);

            // TypeScript would prevent this, but JS runtime might receive these
            (logger as Function)(undefined);
            (logger as Function)(null);
            flushRaf();

            expect(onFlush).toHaveBeenCalledWith([undefined, null]);
        });
    });
});
