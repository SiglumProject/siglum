import {createContext,runInContext} from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const source = readFileSync(resolve(__dirname, '../../src/worker.js'), 'utf8');
const context = createContext({ self: { postMessage() {} }, TextDecoder, Uint8Array, setTimeout, clearTimeout });
runInContext(source, context);
const parse = command => { context.command = command; return runInContext('parseToolCommand(command)', context); };
describe('tool command tokenization', () => {
    it('preserves quoted data arguments without shell interpretation', () => {
        expect(parse('latexminted config --timestamp "20261106000000" ABC')).toEqual(['latexminted','config','--timestamp','20261106000000','ABC']);
        expect(parse("latexminted highlight 'source with spaces'")).toEqual(['latexminted','highlight','source with spaces']);
        expect(parse('latexminted "literal;value"')).toEqual(['latexminted','literal;value']);
    });
    it.each([';', '|', '&', '<', '>', '$', '`', '\0', '\r', '\n'])(
        'rejects an unquoted shell expression or control character %j', value => {
            expect(() => parse('latexminted config ' + value + 'other')).toThrow();
        });
    it('rejects unterminated quoting', () => {
        expect(() => parse('latexminted "unfinished')).toThrow('Unclosed');
    });
});


describe('native process tool configuration', () => {
    const nativeArgs = (connected, commands = []) => {
        context.connected = connected;
        context.commands = commands;
        return runInContext('texProcessArguments({siglumRunTool: connected ? () => 0 : null}, commands)', context);
    };
    it('keeps shell execution disabled without a connected provider', () => {
        expect(nativeArgs(false, ['registered-tool'])).toEqual(['--no-shell-escape']);
    });
    it('overrides native defaults with exactly the registered executable names', () => {
        expect(nativeArgs(true, ['custom.tool', 'another-tool'])).toEqual([
            '--shell-restricted', '--cnf-line=shell_escape_commands=custom.tool,another-tool',
        ]);
    });
    it.each([[], ['tool,other'], ['tool --shell-escape'], ['../tool'], ['tool\nother']].map(commands => ({ commands })))('rejects malformed native allowlist $commands', ({ commands }) => {
        expect(() => nativeArgs(true, commands)).toThrow('Invalid native process tool allowlist');
    });
});
