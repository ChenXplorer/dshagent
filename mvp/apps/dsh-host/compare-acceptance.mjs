import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Pass before.json after.json from capture-acceptance.ts');
const before = JSON.parse(await readFile(beforePath, 'utf8'));
const after = JSON.parse(await readFile(afterPath, 'utf8'));
assert.equal(before.activeTasks.length, 0, 'Before-restart tasks must be settled');
assert.equal(after.activeTasks.length, 0, 'Replay must not create a new running task');
for (const previous of before.sessions) {
  const current = after.sessions.find(session => session.sessionId === previous.sessionId);
  assert.ok(current, 'Session disappeared');
  assert.equal(previous.openTurn, false); assert.equal(current.openTurn, false);
  if (previous.proofMarker) {
    assert.equal(previous.finalAssistantContainsProof, true, 'Native final assistant message lacks proof marker');
    assert.equal(current.finalAssistantContainsProof, true, 'Native final assistant proof changed after replay');
  }
  assert.deepEqual(current.eventDigests.slice(0, previous.eventCount), previous.eventDigests, 'Existing native event prefix changed');
  assert.equal(current.duplicateProjections, 0); assert.equal(current.resultsWithoutCall, 0);
  assert.equal(current.callsWithoutResult, previous.callsWithoutResult, 'Replay changed unresolved tool evidence');
  if (current.callsWithoutResult > 0) {
    assert.ok((previous.tasks.some(task => task.state === 'cancelled')
      && previous.turnEndings?.some(ending => ending.kind === 'aborted'))
      || (previous.tasks.some(task => task.state === 'failed')
      && previous.turnEndings?.some(ending => ending.kind === 'error')),
    'Unresolved tools require an explicitly cancelled or failed acceptance task and its matching native outcome');
  }
  assert.deepEqual(current.projections, previous.projections, 'Replay created extra trajectory projections');
  assert.deepEqual(current.tasks, previous.tasks, 'Replay changed official task/session/runtime mappings');
  assert.deepEqual(current.calls, previous.calls); assert.deepEqual(current.results, previous.results);
}
console.log(JSON.stringify({ preservedNativeHistory: true, duplicateProjections: 0, recreatedTasks: 0, sessions: before.sessions.length }));
