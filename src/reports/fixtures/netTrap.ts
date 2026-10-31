// Test-only: replaces every network entry point of this process with a trap that
// records the attempt and throws. Imported FIRST by pdfOfflineChild.tsx. The one
// exception is fetch() of an in-memory data: URL (the layout engine's bundled
// WebAssembly is loaded that way; no network is involved): it is passed through
// and listed separately.
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';

export const attempts: string[] = [];
export const trapped: string[] = [];
export const dataUrlFetches: number[] = [];
const realFetch = globalThis.fetch;
const trap = (name: string, obj: object, key: string) => {
  Object.defineProperty(obj, key, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      if (name === 'fetch' && typeof args[0] === 'string' && args[0].startsWith('data:')) {
        dataUrlFetches.push(args[0].length);
        return realFetch(args[0]);
      }
      attempts.push(name);
      throw new Error(`network access attempted during PDF generation: ${name}`);
    },
  });
  trapped.push(name);
};
trap('fetch', globalThis, 'fetch');
trap('http.request', http, 'request');
trap('http.get', http, 'get');
trap('https.request', https, 'request');
trap('https.get', https, 'get');
trap('net.connect', net, 'connect');
trap('net.createConnection', net, 'createConnection');
trap('tls.connect', tls, 'connect');
trap('dns.lookup', dns, 'lookup');
