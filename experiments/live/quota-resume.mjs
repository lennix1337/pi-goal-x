// Real managed Pi SDK + pi-goal-x + pi-multi-account; scripted providers, no external model calls.
// Every account hits its quota while a goal runs; the goal must stay active, wait without
// retrying, and resume exactly once by itself when an account comes back. No user message.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const args = process.argv.slice(2);
const reloadWhileWaiting = args.includes('--reload') || process.env.QUOTA_RESUME_RELOAD === '1';
const output = args.find(arg => !arg.startsWith('--'));
const receipt = output ? resolve(output) : mkdtempSync(join(tmpdir(), 'goal-quota-evidence-'));
if (output) mkdirSync(receipt, { recursive: false });
const liveAgent = join(homedir(), '.pi', 'agent');
const version = readFileSync(join(liveAgent, 'install/current-version'), 'utf8').trim();
const sdkRoot = process.env.PI_GOAL_SDK_ROOT || join(liveAgent, 'install/releases', version, 'node_modules/@earendil-works');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const multiAccount = resolve(process.env.PI_MULTI_ACCOUNT_ENTRY || join(repo, '../pi-multi-account/index.ts'));
const scratch = mkdtempSync(join(tmpdir(), 'goal-quota-runtime-'));
const agent = join(scratch, 'agent');
mkdirSync(agent);
for (const key of Object.keys(process.env)) {
  if (/TOKEN|API_KEY|SECRET|PASSWORD/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: agent, PI_GOAL_GLOBAL_SETTINGS_FILE: join(agent, 'pi-goal-x-settings.json'),
  PI_GOAL_SETTINGS_FILE: join(scratch, '.pi/pi-goal-x-settings.json'), PI_OFFLINE: '1',
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

const providers = ['quota-a', 'quota-b'];
const COOLDOWN_MS = 3000;
writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE, JSON.stringify({ maxAutonomousRuns: 5, strictExecutionContract: false }));
writeFileSync(join(agent, 'auth.json'), JSON.stringify(Object.fromEntries(providers.map(p => [p, { type: 'api_key', key: `fixture-${p}` }]))));
writeFileSync(join(agent, 'provider-failover.json'), JSON.stringify({
  includeCursor: false, childProxy: false, autoDiscoverModels: false, showUsage: false, includeOtherProviders: true,
  fallbacks: providers, autoContinue: true, contextGuard: false, resumeAfterAllAccountsRecover: true,
  cooldownMs: COOLDOWN_MS, pendingPollMs: 100,
}));

const sdk = await import(pathToFileURL(join(sdkRoot, 'pi-coding-agent/dist/index.js')).href);
const ai = await import(pathToFileURL(join(sdkRoot, 'pi-ai/dist/index.js')).href);
const runtime = await sdk.ModelRuntime.create({ authPath: join(agent, 'auth.json'), modelsPath: null, modelsStorePath: join(agent, 'models.json'), refreshOnCreate: false });

// quota: 'open' before the goal exists, 'exhausted' until the test restores it, then 'restored'.
let quota = 'open';
let step = 0;
const requests = [];
const userMessages = [];
const errors = [];
const call = (name, args) => ({ type: 'toolCall', id: `quota-${step++}`, name, arguments: args });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
for (const provider of providers) runtime.registerProvider(provider, {
  baseUrl: 'https://invalid.local', apiKey: `fixture-${provider}`, api: 'openai-completions',
  models: [{ id: 'fixture', name: provider, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  streamSimple(model, context) {
    requests.push({ provider: model.provider, quota, at: Date.now() });
    const stream = ai.createAssistantMessageEventStream();
    const last = context.messages.at(-1);
    let message;
    if (quota === 'exhausted') {
      message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'error', errorMessage: 'You exceeded your current quota, please check your plan and billing details.', usage };
      queueMicrotask(() => { stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); });
      return stream;
    }
    let content;
    if (quota === 'open') {
      content = [call('create_goal', { objective: 'Disposable quota recovery validation', max_autonomous_runs: 5 })];
      quota = 'exhausted'; // the goal exists from here on; every account is out of quota
    } else if (last.role === 'toolResult') {
      content = [{ type: 'text', text: 'stopped after recovery' }];
    } else {
      content = [call('update_goal', { status: 'paused', reason: 'Fixture: work resumed after quota recovery; stop this disposable run' })];
    }
    const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
    message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason, usage };
    queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); });
    return stream;
  },
});

const settingsManager = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir: agent, settingsManager,
  additionalExtensionPaths: [join(repo, 'extensions/goal.ts'), multiAccount], disabledBuiltinExtensions: ['mcp', 'codemode'],
  noContextFiles: true, noSkills: true, noPromptTemplates: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir: agent, modelRuntime: runtime,
  model: runtime.getModel('quota-a', 'fixture'), resourceLoader: loader, settingsManager,
  sessionManager: sdk.SessionManager.create(scratch, join(scratch, 'sessions')), tools: ['create_goal', 'update_goal', 'get_goal'] });

const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(predicate, what, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; requests=${JSON.stringify(requests.map(r => `${r.provider}:${r.quota}`))}`);
    await sleep(20);
  }
}
const goalOnDisk = () => {
  const goal = results.findLast(row => row.goal)?.goal;
  return goal ? readFileSync(resolve(scratch, goal.activePath), 'utf8') : '';
};
try {
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(String(error.error)) });
  session.subscribe(event => {
    if (event.type === 'tool_execution_end') results.push({ tool: event.toolName, isError: event.isError, goal: event.result.details?.goal });
    if (event.type === 'message_start' && event.message.role !== 'assistant' && event.message.role !== 'toolResult') userMessages.push({ quota, role: event.message.role, text: JSON.stringify(event.message.content).slice(0, 300) });
  });
  await session.prompt('Create the disposable quota validation goal.');
  const created = results.find(row => row.tool === 'create_goal')?.goal;
  assert.ok(created, 'create_goal ran');

  // Both accounts fail with quota; the goal must stay active and the session must stop asking.
  await waitFor(() => requests.filter(r => r.quota === 'exhausted').length >= providers.length, 'every account to hit its quota');
  await sleep(400);
  const exhaustedRequests = requests.filter(r => r.quota === 'exhausted').length;
  await sleep(400);
  assert.equal(requests.filter(r => r.quota === 'exhausted').length, exhaustedRequests, 'no busy retry while every account is out of quota');
  const waiting = goalOnDisk();
  assert.match(waiting, /status:\s*active|"status":\s*"active"|Status: active/i, 'goal stays active while waiting');
  const failoverState = JSON.parse(readFileSync(join(agent, 'provider-failover-state.json'), 'utf8'));
  assert.ok(failoverState.pendingFrom && failoverState.pendingReason, 'the wait is persisted, not only held in memory');
  let reload;
  if (reloadWhileWaiting) {
    // A reload while waiting: the goal's own recovery continuation must carry the wait over.
    const before = requests.length;
    await session.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    await waitFor(() => requests.length > before, 'the goal to retry once after reload');
    await waitFor(() => requests.slice(before).filter(r => r.quota === 'exhausted').length >= providers.length, 'every account to refuse again after reload');
    // Retries come from cooldown deadlines (COOLDOWN_MS), so measure well inside one.
    await sleep(300);
    const settled = requests.length;
    await sleep(500);
    assert.equal(requests.length, settled, 'no busy retry after reload either');
    reload = { requestsAfterReload: requests.slice(before).map(r => `${r.provider}:${r.quota}`) };
  }

  quota = 'restored';
  const restoredAt = Date.now();
  await waitFor(() => results.some(row => row.tool === 'update_goal' && row.goal?.status === 'paused'), 'the goal to resume by itself after quota recovery', COOLDOWN_MS * 6);
  await sleep(COOLDOWN_MS + 500); // a duplicate wake would show up here
  const afterRecovery = requests.filter(r => r.quota === 'restored');
  const resumedRuns = userMessages.filter(m => m.quota === 'restored').length;
  assert.equal(resumedRuns, 1, `exactly one automatic resume message after recovery (got ${resumedRuns})`);
  assert.equal(afterRecovery.length, 1, `one provider request after recovery: the resumed turn (got ${afterRecovery.length})`);
  assert.ok(!userMessages.some(m => /Create the disposable/.test(m.text) && m.quota !== 'open'), 'no user prompt was needed to resume');
  assert.equal(networkAttempts, 0);
  const final = results.findLast(row => row.goal)?.goal;
  const result = { passed: true, sdk: version, node: process.version, goalId: created.id,
    providerRequests: requests.map(r => `${r.provider}:${r.quota}`), exhaustedRequests, resumedRuns,
    persistedWait: { pendingFrom: failoverState.pendingFrom, pendingReason: failoverState.pendingReason }, reload,
    recoveryLatencyMs: afterRecovery[0].at - restoredAt, userMessages, finalStatus: final.status, used: final.scheduler?.used,
    networkAttempts, extensionErrors: errors, scratch,
    limitations: 'Scripted providers, two extensions only; quota return is a cooldown deadline, not a live provider signal.' };
  writeFileSync(join(receipt, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  writeFileSync(join(receipt, 'failure.json'), JSON.stringify({ passed: false, quota, error: String(error), requests, userMessages,
    extensionErrors: errors, scratch, results }, null, 2) + '\n');
  console.error(JSON.stringify({ error: String(error), requests: requests.map(r => `${r.provider}:${r.quota}`), userMessages, errors, results: results.map(r => [r.tool, r.isError, r.goal?.status]) }, null, 2));
  process.exitCode = 1;
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
