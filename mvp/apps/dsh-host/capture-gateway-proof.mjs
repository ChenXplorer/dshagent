import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [tokenPath, nativeEvidencePath, outputPath, baseUrl = 'http://127.0.0.1:3380'] = process.argv.slice(2);
if (!tokenPath || !nativeEvidencePath || !outputPath) throw new Error('Pass gatewayTokenFile nativeCaptureJson outputJson [gatewayURL]');
const token = (await readFile(tokenPath, 'utf8')).trim();
const evidence = JSON.parse(await readFile(nativeEvidencePath, 'utf8'));
const proofs = [];
for (const expected of evidence.sessions) {
  const cancelled = !expected.proofMarker && expected.tasks.length === 1 && expected.tasks[0].state === 'cancelled';
  const failed = !expected.proofMarker && expected.tasks.length === 1 && expected.tasks[0].state === 'failed';
  const taskId = expected.proofTaskId ?? (cancelled || failed ? expected.tasks[0].externalTaskId : undefined);
  assert.ok(taskId && (expected.proofMarker || cancelled || failed), 'Capture must include a task-linked proof or a single cancelled/failed task');
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 30000);
  try {
    const response = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(expected.sessionId)}/events`, {
      headers: { authorization: `Bearer ${token}` }, signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = ''; let snapshot;
    while (!snapshot) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Gateway stream ended before native snapshot');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Native snapshot exceeds proof capture limit');
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (parsed.type === 'snapshot') { snapshot = parsed; break; }
      }
    }
    const events = snapshot.records.filter(record => record.type === 'event').map(record => record.event);
    const taskEvents = events.filter(event => event.data?.multica?.taskId === taskId);
    const lastAssistant = taskEvents.findLast(event => event.type === 'assistant/message');
    const text = lastAssistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    const calls = taskEvents.filter(event => event.type === 'tool/call');
    const results = taskEvents.filter(event => event.type === 'tool/result');
    const ending = events.findLast(event => event.type === 'turn/end');
    const proof = { sessionId: expected.sessionId, taskId, cursor: snapshot.cursor,
      snapshotHasMore: snapshot.hasMore, proofType: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
      finalAssistantContainsProof: !!expected.proofMarker && text.includes(expected.proofMarker),
      nativeTurnEndKind: ending?.data.reason.kind,
      nativeCancellationKind: ending?.data.reason.kind === 'aborted' ? ending.data.reason.reason.kind : undefined,
      nativeAssistantMessages: taskEvents.filter(event => event.type === 'assistant/message').length,
      nativeToolCalls: calls.length, nativeToolResults: results.length,
      pairedResults: results.filter(result => calls.some(call => call.data.callId === result.data.message.source.callId)).length,
      rawEvents: taskEvents.filter(event => event.type === 'multica/event').length };
    proofs.push(proof);
  } finally { clearTimeout(deadline); abort.abort(); }
}
await writeFile(outputPath, JSON.stringify({ capturedAt: new Date().toISOString(), proofs }, null, 2) + '\n', { mode: 0o600 });
for (const proof of proofs) {
  if (proof.proofType === 'failed') {
    assert.equal(proof.nativeTurnEndKind, 'error', 'Failed task must retain its native error termination');
    assert.equal(proof.pairedResults, proof.nativeToolResults, 'Failed task has an invented unmatched result');
    continue;
  }
  if (proof.proofType === 'cancelled') {
    assert.equal(proof.nativeTurnEndKind, 'aborted', 'Cancelled task must close its native turn as aborted');
    assert.equal(proof.nativeCancellationKind, 'user', 'Expected genuine user cancellation reason');
    assert.equal(proof.nativeAssistantMessages, 0, 'Cancelled proof task unexpectedly published a final assistant message');
    assert.equal(proof.pairedResults, proof.nativeToolResults, 'Cancelled task has an invented unmatched result');
    continue;
  }
  assert.equal(proof.finalAssistantContainsProof, true, 'Gateway native final assistant proof absent; inspect snapshot window');
  assert.ok(proof.nativeToolCalls > 0, 'Gateway native tool calls absent');
  assert.equal(proof.pairedResults, proof.nativeToolResults, 'Gateway tool result lacks its real call');
  assert.equal(proof.nativeToolCalls, proof.nativeToolResults, 'Gateway native tool execution incomplete');
}
console.log(JSON.stringify({ outputPath, nativeGatewayProofs: proofs }));
