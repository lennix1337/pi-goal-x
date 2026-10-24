// Real managed Pi SDK + registered goal tools; scripted provider, no external model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const output = process.argv[2];
const receipt = output ? resolve(output) : mkdtempSync(join(tmpdir(), 'goal-resume-evidence-'));
if (output) mkdirSync(receipt, { recursive: false });
const liveAgent = join(homedir(), '.pi', 'agent');
const version = readFileSync(join(liveAgent, 'install/current-version'), 'utf8').trim();
const sdkRoot = process.env.PI_GOAL_SDK_ROOT || join(liveAgent, 'install/releases', version, 'node_modules/@earendil-works');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(join(tmpdir(), 'goal-resume-runtime-'));
const agent = join(scratch, 'agent');
mkdirSync(agent);
for (const key of Object.keys(process.env)) {
  if (/TOKEN|API_KEY|SECRET|PASSWORD/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: agent, PI_GOAL_GLOBAL_SETTINGS_FILE: join(agent, 'pi-goal-x-settings.json'),
  PI_GOAL_SETTINGS_FILE: join(scratch, '.pi/pi-goal-x-settings.json'),
  PI_SUBAGENT_CHILD: '0', PI_SUBAGENT_DEPTH: '0', OPTCHAT_HOME: join(scratch, 'optchat'),
});
delete process.env.OPTCHAT_PROFILE;
let networkAttempts = 0;
function rejectNetwork(boundary) {
  networkAttempts++;
  throw new Error(`Offline runtime probe forbids network at ${boundary}`);
}
globalThis.fetch = async () => rejectNetwork('fetch');
net.Socket.prototype.connect = () => rejectNetwork('socket');
writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE, JSON.stringify({ maxAutonomousRuns: 3, strictExecutionContract: false }));
const sdk = await import(pathToFileURL(join(sdkRoot, 'pi-coding-agent/dist/index.js')).href);
const ai = await import(pathToFileURL(join(sdkRoot, 'pi-ai/dist/index.js')).href);
const runtime = await sdk.ModelRuntime.create({ authPath: join(agent, 'auth.json'), modelsPath: null, modelsStorePath: join(agent, 'models.json'), refreshOnCreate: false });
let phase = 'setup';
let step = 0;
let continuationRequests = 0;
const results = [];
const errors = [];
let resolveFinished;
const finished = new Promise(resolveDone => { resolveFinished = resolveDone; });
const call = (name, args) => ({ type: 'toolCall', id: `runtime-${phase}-${step++}`, name, arguments: args });
runtime.registerProvider('goal-runtime-fixture', {
  baseUrl: 'https://invalid.local', apiKey: 'offline-fixture', api: 'openai-completions',
  models: [{ id: 'fixture', name: 'Offline fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  streamSimple(model, context) {
    const stream = ai.createAssistantMessageEventStream();
    const last = context.messages.at(-1);
    if (last.role === 'toolResult') assert.notEqual(last.isError, true, JSON.stringify(last.content));
    let content;
    if (phase === 'setup') {
      content = step === 0
        ? [call('create_goal', { objective: 'Disposable conversational resume runtime validation', max_autonomous_runs: 3 })]
        : [call('update_goal', { status: 'paused', reason: 'Fixture setup pause' })];
    } else if (phase === 'pause') {
      content = [call('update_goal', { status: 'paused', reason: 'Fixture setup pause' })];
    } else if (phase === 'resume') {
      if (step < 2) content = [call('update_goal', { status: 'active' })];
      else { phase = 'waiting-continuation'; content = [{ type: 'text', text: 'resume-authorized' }]; }
    } else {
      assert.equal(phase, 'waiting-continuation');
      assert.ok(context.messages.some(message => JSON.stringify(message).includes('pi_goal_continuation')), 'Continuation marker must reach the provider context');
      continuationRequests++;
      content = [call('update_goal', { status: 'paused', reason: 'Fixture continuation observed; stop this disposable run' })];
    }
    const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); });
    return stream;
  },
});
const settingsManager = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir: agent, settingsManager,
  additionalExtensionPaths: [join(repo, 'extensions/goal.ts')], disabledBuiltinExtensions: ['mcp', 'codemode'],
  noContextFiles: true, noSkills: true, noPromptTemplates: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir: agent, modelRuntime: runtime,
  model: runtime.getModel('goal-runtime-fixture', 'fixture'), resourceLoader: loader, settingsManager,
  sessionManager: sdk.SessionManager.create(scratch, join(scratch, 'sessions')), tools: ['create_goal', 'update_goal', 'get_goal'] });
let timeout;
try {
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error.error) });
  session.subscribe(event => {
    if (event.type === 'tool_execution_end') {
      assert.notEqual(event.isError, true, JSON.stringify(event.result));
      results.push({ tool: event.toolName, goal: event.result.details?.goal });
    }
    if (event.type === 'message_end' && event.message.stopReason === 'error') errors.push(event.message.errorMessage);
    if (event.type === 'agent_end' && (continuationRequests === 1 || errors.length)) resolveFinished();
  });
  await session.prompt('Create the disposable validation goal.');
  assert.equal(results.at(-1).goal.status, 'active');
  phase = 'pause';
  await session.prompt('Pause the disposable validation goal for the fixture.');
  const before = results.at(-1).goal;
  assert.equal(before.status, 'paused');
  const beforeTasks = JSON.stringify(before.taskList);
  await session.reload(); // Actual SDK reload lifecycle, not a re-imported mock extension.
  assert.deepEqual(loader.getExtensions().errors, []);
  const update = loader.getExtensions().extensions.flatMap(extension => [...extension.tools]).find(([name]) => name === 'update_goal')[1].definition;
  assert.ok(JSON.stringify(update.parameters).includes('active'));
  phase = 'resume'; step = 0;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('No autonomous continuation after resume')), 15000); });
  await session.prompt('Resume the paused goal now. This is explicit authorization for the fixture goal only.');
  await Promise.race([finished, deadline]);
  const resumed = results.filter(row => row.goal?.status === 'active' && row.tool === 'update_goal');
  assert.equal(resumed.length, 2);
  assert.equal(resumed[0].goal.id, before.id);
  // turn_start may update runtime bookkeeping between calls; the resume must not reset the generation or allowance.
  assert.equal(resumed[1].goal.scheduler.generation, resumed[0].goal.scheduler.generation);
  assert.equal(resumed[1].goal.scheduler.used, resumed[0].goal.scheduler.used);
  assert.equal(resumed[0].goal.objective, before.objective);
  assert.equal(JSON.stringify(resumed[0].goal.taskList), beforeTasks);
  assert.equal(resumed[0].goal.maxAutonomousRuns, before.maxAutonomousRuns);
  assert.equal(continuationRequests, 1);
  const final = results.at(-1).goal;
  assert.equal(final.status, 'paused');
  assert.equal(final.scheduler.used, 1);
  const disk = readFileSync(resolve(scratch, final.activePath), 'utf8');
  const ledger = readFileSync(join(scratch, '.pi/goals/goal_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(ledger.filter(event => event.type === 'goal_resumed').length, 1);
  assert.ok(disk.includes(before.id));
  assert.equal(networkAttempts, 0);
  assert.deepEqual(errors, []);
  const result = { passed: true, sdk: version, node: process.version, sdkReload: true, toolSchemaActive: true,
    goalId: before.id, continuationRequests, resumeEvents: 1, duplicateIsNoop: true,
    toolExecutions: results.map(row => row.tool), externalModelRequests: 0, networkAttempts, extensionErrors: errors,
    persistedSha256: createHash('sha256').update(disk).digest('hex'), scratch,
    limitations: 'Scripted provider and isolated single extension; not the current interactive profile or real model reasoning.' };
  writeFileSync(join(receipt, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(join(receipt, 'failure.json'), JSON.stringify({ passed: false, phase, step, continuationRequests,
    error: String(error), extensionErrors: errors, scratch, results }, null, 2) + '\n');
  throw error;
} finally {
  clearTimeout(timeout);
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
