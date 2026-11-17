/**
 * Live probe against the real iCloud CalDAV root with throwaway credentials.
 *
 * Proves the transport layer end to end: DNS, TLS, PROPFIND, Basic auth
 * challenge, and that our error mapping surfaces the app-specific-password
 * hint instead of a raw stack trace. It is expected to FAIL auth — that is
 * the point. Credentials here are deliberately invalid.
 */
import { RemindersClient } from './lib/caldav.js';

const client = new RemindersClient({
  username: 'probe@example.com',
  password: 'aaaa-bbbb-cccc-dddd',
  baseUrl: 'https://caldav.icloud.com/',
  timeoutMs: 15000,
});

const t0 = Date.now();
try {
  const home = await client.discoverHome();
  console.log('UNEXPECTED success, home =', home);
} catch (err) {
  console.log('elapsed_ms:', Date.now() - t0);
  console.log('error_name:', err.name);
  console.log('status:', err.status ?? '(none)');
  console.log('message:', err.message);
  const ok = (err.status === 401 || err.status === 403) && /app-specific password/i.test(err.message);
  console.log(ok ? 'LIVE PROBE OK: real iCloud rejected the credential and mapped to the ASP hint' : 'LIVE PROBE UNEXPECTED');
  process.exitCode = ok ? 0 : 1;
}
