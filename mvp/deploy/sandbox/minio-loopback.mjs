import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

// Keep the official storage endpoint and S3 signed Host unchanged. Only this
// provisioning process routes MinIO through an already-established SSH tunnel.
export function routeMinioThroughLoopback() {
  const original = dns.lookup;
  dns.lookup = function lookup(hostname, options, callback) {
    if (hostname !== 'minio') return original.apply(this, arguments);
    if (typeof options === 'function') { callback = options; options = {}; }
    const all = typeof options === 'object' && options?.all;
    queueMicrotask(() => all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
  };
  syncBuiltinESMExports();
  return () => { dns.lookup = original; syncBuiltinESMExports(); };
}
