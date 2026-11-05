/** Publish one R2 object using credentials restricted to the runtime bucket. */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUCKET = 'siglum-bundles';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());

function objectPath(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._+/-]+$/.test(key) ||
      Buffer.byteLength(key) > 1024 || key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid runtime object key');
  }
  return `/${BUCKET}/${key.split('/').map(encode).join('/')}`;
}

function headerValue(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error('Invalid object metadata header');
  return value.trim().replace(/\s+/g, ' ');
}

/** Build a SigV4 request without exposing credentials through logs or URLs. */
export function signRuntimeObject({ accountId, accessKeyId, secretAccessKey, key, body, copyFrom,
  contentType, cacheControl, now = new Date() }) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '')) throw new Error('Invalid Cloudflare account ID');
  if (typeof accessKeyId !== 'string' || !/^[A-Za-z0-9]+$/.test(accessKeyId) ||
      typeof secretAccessKey !== 'string' || !secretAccessKey || /[\r\n]/.test(secretAccessKey)) {
    throw new Error('Missing or invalid R2 S3 credentials');
  }
  if ((body !== undefined) === (copyFrom !== undefined)) throw new Error('Supply either file bytes or a copy source');
  if (body !== undefined && !(body instanceof Uint8Array)) throw new Error('Object body must be bytes');
  if (copyFrom === key) throw new Error('Copy source and destination must differ');
  const path = objectPath(key);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const payloadHash = sha256(body ?? Buffer.alloc(0));
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };
  if (contentType !== undefined) headers['content-type'] = headerValue(contentType);
  if (cacheControl !== undefined) headers['cache-control'] = headerValue(cacheControl);
  if (copyFrom !== undefined) {
    headers['x-amz-copy-source'] = objectPath(copyFrom);
    // Preserve source metadata unless the caller explicitly supplies a replacement.
    if (contentType !== undefined || cacheControl !== undefined) headers['x-amz-metadata-directive'] = 'REPLACE';
  }
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = ['PUT', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${host}${path}`, init: { method: 'PUT', headers, ...(body === undefined ? {} : { body }), redirect: 'error' } };
}

/** A CopyObject can report failure in an HTTP 200 response; inspect its XML. */
export async function publishRuntimeObject(options, fetchResource = globalThis.fetch) {
  const { url, init } = signRuntimeObject(options);
  let response;
  try {
    response = await fetchResource(url, { ...init, signal: AbortSignal.timeout(120000) });
  } catch {
    throw new Error('R2 object request failed before receiving a response');
  }
  if (!response.ok) throw new Error(`R2 object request failed: HTTP ${response.status}`);
  if (options.copyFrom !== undefined) {
    let xml;
    try { xml = await response.text(); } catch { throw new Error('R2 copy response could not be read'); }
    const result = xml.match(/^\s*(?:<\?xml\s[^?]*\?>\s*)?<((?:[A-Za-z_][\w.-]*:)?CopyObjectResult)(?:\s[^<>]*)?>([\s\S]*)<\/\1>\s*$/);
    const etag = result?.[2].match(/<((?:[A-Za-z_][\w.-]*:)?ETag)(?:\s[^<>]*)?>([^<]*)<\/\1>/)?.[2].trim();
    if (/<(?:[A-Za-z0-9_]+:)?Error(?:\s|\/?>)/.test(xml) ||
        !result || !etag || etag === '""' || etag === '&quot;&quot;') {
      throw new Error('R2 copy did not return a successful CopyObjectResult');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [key, ...arguments_] = process.argv.slice(2);
    const options = { key, accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY };
    let file;
    const seen = new Set();
    for (let index = 0; index < arguments_.length; index += 2) {
      const flag = arguments_[index], value = arguments_[index + 1];
      if (!value || seen.has(flag)) throw new Error('Missing or duplicate runtime object option');
      seen.add(flag);
      if (flag === '--file') file = value;
      else if (flag === '--copy-from') options.copyFrom = value;
      else if (flag === '--content-type') options.contentType = value;
      else if (flag === '--cache-control') options.cacheControl = value;
      else throw new Error('Unknown runtime object option');
    }
    if (file !== undefined) options.body = await readFile(file);
    await publishRuntimeObject(options);
    console.log(`Published runtime object: ${key}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
