import { readFile, writeFile } from 'node:fs/promises';
const [tokenPath, fixturePath, outputPath, baseUrl = 'http://127.0.0.1:3380'] = process.argv.slice(2);
if (!tokenPath || !fixturePath || !outputPath) throw new Error('Pass gatewayTokenFile realConcurrencyFixture outputJson [gatewayURL]');
const token = (await readFile(tokenPath, 'utf8')).trim();
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!Array.isArray(fixture.trials) || !fixture.trials.length) throw new Error('Real submitted fixture must contain trials');
const receipts = [];
for (const { sessionId, requestId, prompt } of fixture.trials) {
  if (typeof sessionId !== 'string' || typeof requestId !== 'string' || typeof prompt !== 'string') throw new Error('Fixture requires the exact originally submitted identities and prompt');
  // Same durable requestId, repeated deliberately after restart. The official
  // SessionController must recognize the accepted native user message.
  for (let duplicate = 1; duplicate <= 2; duplicate++) {
    const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, text: prompt, mode: 'queue' }), signal: AbortSignal.timeout(30000),
    });
    const value = await response.json();
    if (!response.ok || value.accepted !== true) throw new Error(`Native replay admission failed (${response.status})`);
    receipts.push({ sessionId, requestId, duplicate, httpStatus: response.status, accepted: value.accepted });
  }
}
await writeFile(outputPath, JSON.stringify({ replayedAt: new Date().toISOString(), receipts }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ replayReceipts: receipts.length, outputPath }));
