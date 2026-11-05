import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { publishRuntimeObject, signRuntimeObject } from '../../scripts/publish-runtime-object.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const credentials = { accountId, accessKeyId: 'fixtureaccesskey', secretAccessKey: 'fixturesecretkey' };
const options = { ...credentials, key: 'engines/1.2.3/latest.json', body: Buffer.from('{}\n'),
  contentType: 'application/json', cacheControl: 'no-store', now: new Date('2026-01-02T03:04:05.000Z') };
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

describe('bucket-scoped runtime object publishing', () => {
  it('signs an HTTPS R2 PUT with exact payload and descriptor cache metadata', async () => {
    const request = signRuntimeObject(options);
    expect(request.url).toBe(`https://${accountId}.r2.cloudflarestorage.com/siglum-bundles/engines/1.2.3/latest.json`);
    expect(request.init.redirect).toBe('error');
    expect(request.init.body).toEqual(options.body);
    expect(request.init.headers['content-type']).toBe('application/json');
    expect(request.init.headers['cache-control']).toBe('no-store');
    expect(request.init.headers['x-amz-content-sha256']).toBe(sha256(options.body));
    expect(request.init.headers['x-amz-date']).toBe('20260102T030405Z');
    // Independently checked using curl --aws-sigv4 aws:amz:auto:s3 with these
    // dummy credentials, headers, timestamp and body against a localhost sink.
    expect(request.init.headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=fixtureaccesskey/20260102/auto/s3/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=5f9377f37bfa42e49c374a212a631289303f9e21e0baf6d75947bc3419f56fa2');
    let call;
    await publishRuntimeObject(options, async (url, init) => { call = { url, init }; return new Response(null); });
    expect(call.url).toBe(request.url);
    expect(call.init.headers).toEqual(request.init.headers);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('changes the signature when file bytes, metadata, or destination change', () => {
    const signature = signRuntimeObject(options).init.headers.authorization;
    for (const change of [{ body: Buffer.from('changed') }, { cacheControl: 'max-age=60' }, { key: 'channels/latest.json' }]) {
      expect(signRuntimeObject({ ...options, ...change }).init.headers.authorization).not.toBe(signature);
    }
  });

  it('encodes semver build metadata once in the canonical URL', () => {
    expect(signRuntimeObject({ ...options, key: 'engines/1.2.3+build.1/latest.json' }).url).toContain('/engines/1.2.3%2Bbuild.1/latest.json');
  });

  it('copies objects within the same bucket and preserves their source metadata by default', async () => {
    const copy = { ...credentials, key: 'releases/tl2026-0123456789abcdef/wasm/busytex.wasm',
      copyFrom: 'releases/tl2026-fedcba9876543210/wasm/busytex.wasm', now: options.now };
    const request = signRuntimeObject(copy);
    expect(request.init.body).toBeUndefined();
    expect(request.init.headers['x-amz-copy-source']).toBe('/siglum-bundles/' + copy.copyFrom);
    expect(request.init.headers['x-amz-content-sha256']).toBe(sha256(Buffer.alloc(0)));
    expect(request.init.headers['x-amz-metadata-directive']).toBeUndefined();
    await expect(publishRuntimeObject(copy, async () => new Response('<CopyObjectResult><ETag>"fixture"</ETag></CopyObjectResult>'))).resolves.toBeUndefined();
  });

  it('signs explicit metadata replacements on copies', () => {
    const request = signRuntimeObject({ ...options, body: undefined, copyFrom: 'channels/old.json' });
    expect(request.init.headers['x-amz-metadata-directive']).toBe('REPLACE');
    expect(request.init.headers['cache-control']).toBe('no-store');
  });

  it('rejects ambiguous keys, cross-bucket URLs and invalid account destinations before any request', async () => {
    for (const key of ['/outside', '../outside', 'a/../outside', 'a//b', 'a/./b', 'a%2Fb', 'a?b', 'a\\b', 'https://other.example/file']) {
      await expect(publishRuntimeObject({ ...options, key }, async () => { throw new Error('must not fetch'); })).rejects.toThrow('Invalid runtime object key');
      expect(() => signRuntimeObject({ ...credentials, key: 'destination', copyFrom: key })).toThrow('Invalid runtime object key');
    }
    expect(() => signRuntimeObject({ ...options, accountId: 'other.example/' })).toThrow('Invalid Cloudflare account');
  });

  it('rejects absent credentials, conflicting bodies and header injection', () => {
    expect(() => signRuntimeObject({ ...options, secretAccessKey: '' })).toThrow('R2 S3 credentials');
    expect(() => signRuntimeObject({ ...options, body: undefined })).toThrow('either file bytes or a copy source');
    expect(() => signRuntimeObject({ ...options, copyFrom: 'source' })).toThrow('either file bytes or a copy source');
    expect(() => signRuntimeObject({ ...credentials, key: 'same', copyFrom: 'same' })).toThrow('must differ');
    expect(() => signRuntimeObject({ ...options, contentType: 'application/json\r\nx-amz-copy-source: other' })).toThrow('metadata header');
    expect(() => signRuntimeObject({ ...options, contentType: '   ' })).toThrow('metadata header');
  });

  it('rejects unsuccessful HTTP and does not expose response bodies or credentials', async () => {
    await expect(publishRuntimeObject(options, async () => new Response(credentials.secretAccessKey, { status: 403 }))).rejects.toThrow('R2 object request failed: HTTP 403');
    await expect(publishRuntimeObject(options, async () => { throw new Error(credentials.secretAccessKey); })).rejects.toThrow('R2 object request failed before receiving a response');
  });

  it('rejects HTTP 200 copies containing an embedded error or missing success XML', async () => {
    for (const xml of ['<Error><Code>InternalError</Code></Error>', '<CopyObjectResult><Error>failed</Error><ETag>fixture</ETag></CopyObjectResult>', '<CopyObjectResult><Error/><ETag>fixture</ETag></CopyObjectResult>', '{}', '<CopyObjectResult/>']) {
      await expect(publishRuntimeObject({ ...credentials, key: 'destination', copyFrom: 'source' }, async () => new Response(xml))).rejects.toThrow('successful CopyObjectResult');
    }
  });
});
