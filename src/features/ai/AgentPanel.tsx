import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { WorkspaceRef, AppEvent } from '../../contracts';
import type { AppSettings } from '../../ui/theme';
import { request, normalizeError } from '../../api';
import type { Provider, ProviderStatus, ModelsResponse } from './ProviderSettings';
import type { Proposal } from './ProposalReview';
import type { AgentContext, AgentStatus, ChatAction, ChatSnapshot, ExecutionPermission, ExecutionRequest, HistoryRow } from './chatTypes';
import { appendHistory, historyEventKey, historyFromEvents } from './chatHistory';
import { ChatView } from './ChatView';
import { useChatWindow } from './chatWindow';
import './agents.css';
export type { AgentContext } from './chatTypes';

export function AgentPanel({ workspace, settings, onChanged, beforeStart, onBusyChange, onDetachedChange, context: incomingContext }: { workspace: WorkspaceRef; settings: AppSettings; onChanged?: (paths: string[]) => void; beforeStart?: () => Promise<boolean>; onBusyChange?: (busy: boolean) => void; onDetachedChange?: (detached: boolean) => void; context?: AgentContext }) {
  const initialProvider = settings.ai?.provider ?? 'codex';
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(() => ({ workspace, provider: initialProvider, model: settings.ai?.models?.[initialProvider] ?? '', reasoningEffort: '', account: null, configuration: { models: [], allowCustom: false, loading: true, instructions: false, executable: settings.providerExecutables?.[initialProvider] ?? '', error: null }, prompt: '', disclosure: false, busy: false, status: 'idle', taskId: '', sessionId: '', loginUrl: '', error: null, history: [], proposals: [], proposalBusy: [], context: incomingContext ?? {}, pages: [], historyPage: 'current.jsonl', settingsOpen: false, executionPermission: 'ask', executions: [] }));
  const state = useRef(snapshot);
  const workspaceKey = `${workspace.id}:${workspace.epoch}`;
  const activeWorkspace = useRef(workspaceKey); activeWorkspace.current = workspaceKey;
  const mounted = useRef(true);
  const refreshRevision = useRef(0); const historyRevision = useRef(0);
  const modelsByProvider = useRef<Partial<Record<Provider, string>>>({ ...settings.ai?.models });
  const reasoningByProvider = useRef<Partial<Record<Provider, string>>>({ ...settings.ai?.reasoningEfforts });
  const customModels = useRef<Partial<Record<Provider, boolean>>>({});
  const sessions = useRef<Partial<Record<Provider, string>>>({});
  const terminalTasks = useRef(new Set<string>());
  const taskTerminalVersion = useRef(0);
  const loginTerminalVersion = useRef(0);
  const operation = useRef<'task' | 'login' | null>(null);
  const providerGeneration = useRef(0);
  const loginTask = useRef('');
  const starting = useRef(false);
  const providerBusy = useRef(false);
  const pendingStart = useRef<Promise<unknown> | null>(null);
  const executionActions = useRef(new Set<string>());
  const permissionQueue = useRef(Promise.resolve());
  const permissionVersion = useRef(0);
  const executionVersions = useRef(new Map<string, number>());
  const executionRevision = useRef(0);
  const flushPending = useRef<(() => void) | null>(null);
  const persistence = useRef(Promise.resolve());
  const liveDuringHistory = useRef<AppEvent[] | null>(null);
  const listenerReady = useRef(Promise.withResolvers<void>());
  const callbacks = useRef({ onChanged, beforeStart, onBusyChange }); callbacks.current = { onChanged, beforeStart, onBusyChange };
  const executables = useRef<Partial<Record<Provider, string>>>({ ...settings.providerExecutables });
  const update = useCallback((change: Partial<ChatSnapshot> | ((previous: ChatSnapshot) => ChatSnapshot)) => {
    if (!mounted.current) return;
    const previous = state.current;
    const candidate = typeof change === 'function' ? change(previous) : { ...previous, ...change };
    if (typeof change !== 'function' && change.busy !== undefined) providerBusy.current = change.busy;
    const busy = providerBusy.current || candidate.executions.some(row => row.status === 'running');
    const next = candidate.busy === busy ? candidate : { ...candidate, busy };
    state.current = next; setSnapshot(next);
    if (next.busy !== previous.busy) callbacks.current.onBusyChange?.(next.busy);
  }, []);
  const valid = (key: string) => mounted.current && activeWorkspace.current === key;
  const configError = (caught: unknown) => update(previous => ({ ...previous, configuration: { ...previous.configuration, error: normalizeError(caught) } }));

  function persistSelection() {
    const key = activeWorkspace.current;
    const value = { provider: state.current.provider, models: { ...modelsByProvider.current }, reasoningEfforts: { ...reasoningByProvider.current } };
    persistence.current = persistence.current.catch(() => {}).then(async () => {
      await invoke('app_settings', { settings: { ai: value } });
      if (mounted.current) window.dispatchEvent(new CustomEvent('texypaper:ai-settings', { detail: { ai: value } }));
    }).catch(caught => { if (valid(key) && state.current.provider === value.provider) configError(caught); });
  }
  async function refresh() {
    const key = activeWorkspace.current; const provider = state.current.provider; const revision = ++refreshRevision.current;
    update(previous => ({ ...previous, configuration: { ...previous.configuration, loading: true, error: null } }));
    const current = () => valid(key) && revision === refreshRevision.current && state.current.provider === provider;
    try {
      const account = await request<ProviderStatus>('provider_status', state.current.workspace, { provider });
      if (!current()) return;
      if (account.provider !== provider) throw { code: 'PROVIDER_PROTOCOL_UNSUPPORTED', message: 'Provider status did not match the selected provider.' };
      if (account.sessionId) sessions.current[provider] = account.sessionId;
      update(previous => ({ ...previous, account, sessionId: sessions.current[provider] ?? '', configuration: { ...previous.configuration, instructions: account.subscription ? false : previous.configuration.instructions } }));
      if (account.available && account.subscription) {
        const result = await request<ModelsResponse>('provider_models', state.current.workspace, { provider });
        if (!current()) return;
        const models = result.models;
        const selected = state.current.model;
        const model = (!result.allowCustom || !customModels.current[provider]) && !models.some(row => row.id === selected) ? models[0]?.id ?? '' : selected;
        const savedEffort = reasoningByProvider.current[provider] ?? '';
        const reasoningEffort = models.find(row => row.id === model)?.reasoningEfforts.some(row => row.value === savedEffort) ? savedEffort : '';
        modelsByProvider.current[provider] = model;
        reasoningByProvider.current[provider] = reasoningEffort;
        update(previous => ({ ...previous, model, reasoningEffort, configuration: { ...previous.configuration, models, allowCustom: result.allowCustom } }));
        persistSelection();
      } else update(previous => ({ ...previous, configuration: { ...previous.configuration, models: [], allowCustom: false } }));
    } catch (caught) { if (current()) configError(caught); }
    finally { if (current()) update(previous => ({ ...previous, configuration: { ...previous.configuration, loading: false } })); }
  }
  async function loadHistory(page = 'current.jsonl') {
    const key = activeWorkspace.current; const revision = ++historyRevision.current;
    liveDuringHistory.current = [];
    try {
      const response = await request<{ events: AppEvent[]; pages: string[]; page?: string }>('agent_history', state.current.workspace, { page });
      if (!valid(key) || revision !== historyRevision.current) return;
      const actualPage = response.page ?? page;
      const received = new Set(response.events.map(historyEventKey));
      const pending = actualPage === 'current.jsonl' ? (liveDuringHistory.current ?? []).filter(event => !received.has(historyEventKey(event))) : [];
      flushPending.current?.();
      liveDuringHistory.current = null;
      update({ history: historyFromEvents([...response.events, ...pending]), pages: response.pages, historyPage: actualPage });
    } catch (caught) { if (valid(key) && revision === historyRevision.current) { liveDuringHistory.current = null; update({ error: normalizeError(caught) }); } }
  }

  useEffect(() => {
    mounted.current = true; let disposed = false; let unlisten: (() => void) | undefined; let flushTimer: number | undefined;
    let pending: HistoryRow | null = null;
    listenerReady.current = Promise.withResolvers<void>();
    const ready = listenerReady.current;
    sessions.current = {}; terminalTasks.current.clear(); operation.current = null; starting.current = false; providerBusy.current = false; pendingStart.current = null; executionActions.current.clear(); permissionVersion.current++;
    executionVersions.current.clear(); executionRevision.current = 0;
    update(previous => ({ ...previous, workspace, account: null, prompt: '', disclosure: false, busy: false, status: 'idle', taskId: '', sessionId: '', loginUrl: '', error: null, history: [], proposals: [], proposalBusy: [], context: incomingContext ?? {}, pages: [], historyPage: 'current.jsonl', executionPermission: 'ask', executions: [] }));
    const append = (row: HistoryRow) => update(previous => previous.historyPage === 'current.jsonl' ? { ...previous, history: appendHistory(previous.history, row) } : previous);
    const flush = () => { window.clearTimeout(flushTimer); flushTimer = undefined; if (pending) { append(pending); pending = null; } };
    flushPending.current = flush;
    const handleEvent = (event: AppEvent) => {
      if (disposed || event.workspaceId !== workspace.id || event.epoch !== workspace.epoch) return;
      liveDuringHistory.current?.push(event);
      const payload = event.payload as Record<string, unknown>;
      const provider = String(payload.provider ?? state.current.provider);
      const taskId = String(payload.taskId ?? state.current.taskId);
      if (event.kind.startsWith('agent/') && taskId && terminalTasks.current.has(taskId)) return;
      if (event.kind === 'agent/text') {
        if (pending && (pending.taskId !== taskId || pending.provider !== provider)) flush();
        if (pending) pending.text += String(payload.delta ?? '');
        else pending = { id: `event:${historyEventKey(event)}`, role: 'assistant', provider, taskId, text: String(payload.delta ?? '') };
        if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 80);
        return;
      }
      flush();
      if (event.kind === 'agent/user' || event.kind === 'agent/tool') {
        append({ id: `event:${historyEventKey(event)}`, role: event.kind === 'agent/user' ? 'user' : 'tool', text: event.kind === 'agent/user' ? String(payload.text ?? '') : `${String(payload.tool ?? '')}${payload.path ? ` · ${String(payload.path)}` : ''}`, provider, taskId });
      } else if (event.kind === 'agent/status') {
        const status = String(payload.status) as AgentStatus;
        if (!['idle', 'running', 'cancelling', 'completed', 'cancelled', 'failed'].includes(status)) return;
        const terminal = ['completed', 'cancelled', 'failed'].includes(status);
        if (terminal) { terminalTasks.current.add(taskId); taskTerminalVersion.current++; operation.current = null; }
        if (payload.sessionId && (provider === 'codex' || provider === 'claude')) sessions.current[provider] = String(payload.sessionId);
        providerBusy.current = !terminal && (status === 'running' || status === 'cancelling');
        update(previous => ({ ...previous, taskId, status, busy: !terminal && (status === 'running' || status === 'cancelling'), sessionId: provider === previous.provider ? sessions.current[previous.provider] ?? '' : previous.sessionId, error: payload.error ? payload.error as ChatSnapshot['error'] : previous.error }));
      } else if (event.kind === 'agent/error') {
        taskTerminalVersion.current++; loginTerminalVersion.current++; operation.current = null;
        if (taskId) terminalTasks.current.add(taskId);
        update({ error: payload.error as ChatSnapshot['error'], busy: false, status: 'failed', loginUrl: '' });
      } else if (event.kind === 'agent/login') {
        if (provider !== state.current.provider) return;
        if (payload.status === 'waiting') { loginTask.current = taskId; operation.current = 'login'; update({ loginUrl: String(payload.url ?? ''), busy: true }); }
        else {
          loginTerminalVersion.current++; operation.current = null;
          if (taskId) terminalTasks.current.add(taskId);
          const account = payload.account as ProviderStatus | undefined;
          update({ loginUrl: '', busy: false, ...(account?.provider === provider ? { account } : {}) });
          void refresh();
        }
      } else if (event.kind === 'proposal/created') update(previous => ({ ...previous, proposals: [...previous.proposals.filter(row => row.id !== payload.id), payload as unknown as Proposal] }));
      else if (event.kind === 'proposal/conflicted') update(previous => ({ ...previous, proposals: previous.proposals.map(row => row.id === payload.id ? { ...row, status: 'conflicted', error: payload.error as Proposal['error'] } : row) }));
      else if (event.kind === 'command/updated') {
        const execution = payload as unknown as ExecutionRequest;
        if (execution.workspaceId !== workspace.id || execution.epoch !== workspace.epoch) return;
        executionVersions.current.set(execution.id, ++executionRevision.current);
        update(previous => ({ ...previous, executions: [...previous.executions.filter(row => row.id !== execution.id), execution] }));
      } else if (event.kind === 'command/permission') {
        const permission = payload.permission;
        if (permission === 'ask' || permission === 'deny' || permission === 'session') { permissionVersion.current++; update({ executionPermission: permission }); }
      }
    };
    void listen<AppEvent>('texypaper:event', ({ payload }) => handleEvent(payload)).then(cleanup => {
      if (disposed) { cleanup(); ready.resolve(); return; }
      unlisten = cleanup; ready.resolve(); void loadHistory();
      const version = permissionVersion.current;
      void request<{ permission: ExecutionPermission; requests: ExecutionRequest[] }>('command_list', workspace).then(result => {
        if (disposed) return;
        update(previous => ({ ...previous, ...(version === permissionVersion.current ? { executionPermission: result.permission } : {}), executions: [...result.requests.filter(row => !previous.executions.some(existing => existing.id === row.id)), ...previous.executions] }));
      }).catch(caught => { if (!disposed) update({ error: normalizeError(caught) }); });
    }).catch(caught => { ready.reject(caught); void ready.promise.catch(() => {}); if (!disposed) update({ error: normalizeError(caught) }); });
    const key = workspaceKey;
    void request<{ proposals: Proposal[] }>('proposal_list', workspace).then(result => { if (!disposed && valid(key)) update(previous => ({ ...previous, proposals: [...result.proposals.filter(row => !previous.proposals.some(existing => existing.id === row.id)), ...previous.proposals] })); }).catch(caught => { if (!disposed) update({ error: normalizeError(caught) }); });
    const takeContext = (event: Event) => update({ context: (event as CustomEvent<AgentContext>).detail });
    window.addEventListener('texypaper:agent-context', takeContext);
    return () => { disposed = true; refreshRevision.current++; historyRevision.current++; flushPending.current = null; unlisten?.(); window.clearTimeout(flushTimer); ready.resolve(); window.removeEventListener('texypaper:agent-context', takeContext); };
  }, [workspace.id, workspace.epoch, update]);
  useEffect(() => { void refresh(); return () => { refreshRevision.current++; }; }, [workspace.id, workspace.epoch, snapshot.provider]);
  useEffect(() => { if (incomingContext) update({ context: incomingContext }); }, [incomingContext, update]);
  useEffect(() => () => { mounted.current = false; callbacks.current.onBusyChange?.(false); }, []);

  async function send() {
    const initial = state.current;
    if (initial.busy || !initial.prompt.trim() || !initial.disclosure || !initial.account?.subscription || initial.account.provider !== initial.provider || !initial.model || initial.configuration.loading) return;
    if (initial.reasoningEffort && !initial.configuration.models.find(row => row.id === initial.model)?.reasoningEfforts.some(row => row.value === initial.reasoningEffort)) return;
    const key = activeWorkspace.current; const terminalVersion = taskTerminalVersion.current;
    providerGeneration.current++;
    operation.current = 'task'; starting.current = true; update({ error: null, status: 'running', busy: true, taskId: '' });
    try {
      await listenerReady.current.promise;
      if (!valid(key)) return;
      if (state.current.historyPage !== 'current.jsonl') await loadHistory();
      if (!valid(key)) return;
      if (callbacks.current.beforeStart && !(await callbacks.current.beforeStart())) { if (valid(key)) { operation.current = null; update({ status: 'idle', busy: false }); } return; }
      if (!valid(key)) return;
      if (state.current.status === 'cancelling') { operation.current = null; update({ status: 'cancelled', busy: false }); return; }
      starting.current = false;
      const start = request<{ taskId: string; status: AgentStatus }>('agent_start', initial.workspace, { provider: initial.provider, model: initial.model, ...(initial.reasoningEffort ? { reasoningEffort: initial.reasoningEffort } : {}), prompt: initial.prompt, context: initial.context, disclosureAccepted: initial.disclosure });
      pendingStart.current = start;
      const result = await start;
      if (!valid(key)) return;
      const terminal = terminalTasks.current.has(result.taskId) || taskTerminalVersion.current !== terminalVersion;
      update(previous => ({ ...previous, taskId: result.taskId, prompt: previous.prompt === initial.prompt ? '' : previous.prompt, ...(terminal ? {} : { status: previous.status === 'cancelling' ? previous.status : result.status }) }));
    } catch (caught) { if (valid(key)) { operation.current = null; update({ error: normalizeError(caught), status: 'failed', busy: false }); } }
    finally { if (valid(key)) { starting.current = false; pendingStart.current = null; } }
  }
  async function cancel() {
    const key = activeWorkspace.current; const previousStatus = state.current.status;
    if (!state.current.busy) return;
    const providerWasBusy = providerBusy.current;
    const generation = providerGeneration.current; const targetOperation = operation.current;
    const executions = state.current.executions.filter(row => row.status === 'running');
    for (const execution of executions) void executionAction(execution.id, 'cancel');
    if (!providerWasBusy) return;
    update({ status: 'cancelling' });
    if (starting.current && operation.current === 'task') return;
    try {
      await pendingStart.current?.catch(() => {});
      if (!valid(key) || providerGeneration.current !== generation || !providerBusy.current) return;
      await request('agent_cancel', state.current.workspace);
      if (valid(key) && providerGeneration.current === generation && targetOperation === 'login') {
        if (loginTask.current) terminalTasks.current.add(loginTask.current);
        operation.current = null; loginTerminalVersion.current++; update({ busy: false, loginUrl: '', status: 'cancelled' });
      }
    } catch (caught) { if (valid(key)) update({ error: normalizeError(caught), status: previousStatus }); }
  }
  async function login() {
    if (state.current.busy || state.current.configuration.loading) return;
    const key = activeWorkspace.current; const provider = state.current.provider; const terminalVersion = loginTerminalVersion.current;
    operation.current = 'login'; update({ busy: true, error: null });
    providerGeneration.current++; loginTask.current = '';
    try {
      await listenerReady.current.promise;
      if (!valid(key)) return;
      const start = request<{ taskId?: string; status: string }>('provider_login', state.current.workspace, { provider });
      pendingStart.current = start;
      const result = await start;
      if (valid(key) && provider === state.current.provider && result.taskId) loginTask.current = result.taskId;
      if (!valid(key) || provider !== state.current.provider || terminalVersion !== loginTerminalVersion.current) return;
      const instructions = result.status === 'instructions';
      providerBusy.current = !instructions && result.status === 'waiting';
      update(previous => ({ ...previous, busy: !instructions && result.status === 'waiting', configuration: { ...previous.configuration, instructions } }));
      if (instructions || result.status !== 'waiting') operation.current = null;
    } catch (caught) { if (valid(key) && provider === state.current.provider) { operation.current = null; update({ busy: false }); configError(caught); } }
    finally { if (valid(key)) pendingStart.current = null; }
  }
  async function saveExecutable() {
    const key = activeWorkspace.current; const provider = state.current.provider; const executable = state.current.configuration.executable.trim();
    if (state.current.busy || state.current.configuration.loading) return;
    update(previous => ({ ...previous, configuration: { ...previous.configuration, loading: true, error: null } }));
    try {
      const boot = await invoke<{ settings: AppSettings }>('app_bootstrap');
      if (!valid(key) || provider !== state.current.provider) return;
      const saved = await invoke<AppSettings>('app_settings', { settings: { providerExecutables: { ...boot.settings.providerExecutables, [provider]: executable } } });
      if (valid(key) && provider === state.current.provider) {
        executables.current = { ...saved.providerExecutables };
        window.dispatchEvent(new CustomEvent('texypaper:ai-settings', { detail: { providerExecutables: saved.providerExecutables } }));
      }
      if (valid(key) && provider === state.current.provider) await refresh();
    } catch (caught) { if (valid(key) && provider === state.current.provider) configError(caught); }
    finally { if (valid(key) && provider === state.current.provider) update(previous => ({ ...previous, configuration: { ...previous.configuration, loading: false } })); }
  }
  async function decide(id: string, decision: 'apply' | 'reject' | 'undo') {
    const current = state.current; const proposal = current.proposals.find(row => row.id === id);
    if (!proposal || current.proposalBusy.includes(id) || proposal.workspaceId !== current.workspace.id || proposal.epoch !== current.workspace.epoch) return;
    if (decision === 'undo' ? proposal.status !== 'applied' || !proposal.transactionId : decision === 'apply' ? proposal.status !== 'pending' : !['pending', 'conflicted'].includes(proposal.status)) return;
    const key = activeWorkspace.current;
    update(previous => ({ ...previous, proposalBusy: [...previous.proposalBusy, id], proposals: previous.proposals.map(row => row.id === id ? { ...row, error: undefined } : row) }));
    try {
      const result = decision === 'undo' ? await request<{ changed?: { path: string }[]; transactionId?: string }>('undo_transaction', current.workspace, { transactionId: proposal.transactionId }) : await request<{ changed?: { path: string }[]; transactionId?: string }>('proposal_decide', current.workspace, { id, decision });
      if (!valid(key)) return;
      update(previous => ({ ...previous, proposals: previous.proposals.map(row => row.id === id ? { ...row, status: decision === 'undo' ? 'undone' : decision === 'apply' ? 'applied' : 'rejected', transactionId: result.transactionId ?? row.transactionId } : row) }));
      if (decision !== 'reject') callbacks.current.onChanged?.(result.changed?.map(file => file.path) ?? proposal.files.map(file => file.path));
    } catch (caught) {
      if (valid(key)) { const error = normalizeError(caught); update(previous => ({ ...previous, proposals: previous.proposals.map(row => row.id === id ? { ...row, error, status: decision === 'apply' && ['FILE_CONFLICT', 'TRANSACTION_PARTIAL'].includes(error.code) ? 'conflicted' : row.status } : row) })); }
    } finally { if (valid(key)) update(previous => ({ ...previous, proposalBusy: previous.proposalBusy.filter(value => value !== id) })); }
  }
  async function executionAction(id: string, decision: 'approve' | 'reject' | 'cancel') {
    const current = state.current; const execution = current.executions.find(row => row.id === id);
    if (!execution || executionActions.current.has(id) || execution.workspaceId !== current.workspace.id || execution.epoch !== current.workspace.epoch) return;
    if (decision === 'cancel' ? execution.status !== 'running' : execution.status !== 'pending') return;
    const key = activeWorkspace.current; executionActions.current.add(id);
    try {
      if (decision === 'approve' && callbacks.current.beforeStart && !(await callbacks.current.beforeStart())) return;
      if (!valid(key)) return;
      const version = executionVersions.current.get(id);
      const result = await request<ExecutionRequest>(decision === 'cancel' ? 'command_cancel' : 'command_decide', current.workspace, decision === 'cancel' ? { id } : { id, decision });
      if (valid(key) && executionVersions.current.get(id) === version) update(previous => ({ ...previous, executions: [...previous.executions.filter(row => row.id !== id), result] }));
    } catch (caught) { if (valid(key)) update({ error: normalizeError(caught) }); }
    finally { if (valid(key)) executionActions.current.delete(id); }
  }
  function setExecutionPermission(permission: ExecutionPermission, acknowledged = false) {
    if (permission === 'session' && !acknowledged) return;
    const key = activeWorkspace.current; const target = state.current.workspace;
    // Never drop a revocation just because an earlier opt-in is still awaiting native acknowledgement.
    permissionQueue.current = permissionQueue.current.catch(() => {}).then(async () => {
      if (!valid(key)) return;
      const version = executionRevision.current;
      try {
        const result = await request<{ permission: ExecutionPermission; requests: ExecutionRequest[] }>('command_permission', target, { permission, acknowledged });
        if (valid(key)) {
          permissionVersion.current++;
          update(previous => ({ ...previous, executionPermission: result.permission, executions: [...result.requests.map(row => (executionVersions.current.get(row.id) ?? 0) > version ? previous.executions.find(existing => existing.id === row.id) ?? row : row), ...previous.executions.filter(row => !result.requests.some(existing => existing.id === row.id))] }));
        }
      } catch (caught) { if (valid(key)) update({ error: normalizeError(caught) }); }
    });
  }
  function handleAction(action: ChatAction) {
    const current = state.current;
    if (`${current.workspace.id}:${current.workspace.epoch}` !== activeWorkspace.current) return;
    switch (action.type) {
      case 'prompt': update({ prompt: action.value }); break;
      case 'disclosure': if (!current.busy) update({ disclosure: action.value }); break;
      case 'settings': update({ settingsOpen: action.value }); break;
      case 'provider':
        if (current.busy || current.configuration.loading || action.value === current.provider) break;
        refreshRevision.current++; modelsByProvider.current[current.provider] = current.model;
        update({ provider: action.value, model: modelsByProvider.current[action.value] ?? '', reasoningEffort: '', disclosure: false, account: null, sessionId: sessions.current[action.value] ?? '', loginUrl: '', configuration: { models: [], allowCustom: false, loading: true, instructions: false, executable: executables.current[action.value] ?? '', error: null } }); persistSelection(); break;
      case 'model':
        if (!current.busy && !current.configuration.loading && (current.configuration.allowCustom || current.configuration.models.some(row => row.id === action.value))) {
          customModels.current[current.provider] = current.configuration.allowCustom && !current.configuration.models.some(row => row.id === action.value);
          const reasoningEffort = current.configuration.models.find(row => row.id === action.value)?.reasoningEfforts.some(row => row.value === current.reasoningEffort) ? current.reasoningEffort : '';
          modelsByProvider.current[current.provider] = action.value; reasoningByProvider.current[current.provider] = reasoningEffort;
          update({ model: action.value, reasoningEffort }); persistSelection();
        }
        break;
      case 'reasoning':
        if (!current.busy && !current.configuration.loading && (action.value === '' || current.configuration.models.find(row => row.id === current.model)?.reasoningEfforts.some(row => row.value === action.value))) {
          reasoningByProvider.current[current.provider] = action.value;
          update({ reasoningEffort: action.value }); persistSelection();
        }
        break;
      case 'executable': if (!current.busy && !current.configuration.loading) update({ configuration: { ...current.configuration, executable: action.value } }); break;
      case 'send': void send(); break;
      case 'cancel': void cancel(); break;
      case 'refresh': if (!current.busy && !current.configuration.loading) void refresh(); break;
      case 'login': void login(); break;
      case 'open-login': if (current.loginUrl) void invoke('open_external_url', { url: current.loginUrl }).catch(caught => { if (activeWorkspace.current === `${current.workspace.id}:${current.workspace.epoch}`) configError(caught); }); break;
      case 'save-executable': void saveExecutable(); break;
      case 'history': if (!current.busy) void loadHistory(action.page); break;
      case 'decide': void decide(action.id, action.decision); break;
      case 'undo': void decide(action.id, 'undo'); break;
      case 'execution-permission': void setExecutionPermission(action.value, action.acknowledged); break;
      case 'execution-decide': void executionAction(action.id, action.decision); break;
      case 'execution-cancel': void executionAction(action.id, 'cancel'); break;
      case 'dismiss-error': update({ error: null }); break;
      case 'detach': case 'dock': case 'focus': break;
    }
  }
  const actionRef = useRef(handleAction); actionRef.current = handleAction;
  const onAction = useCallback((action: ChatAction) => actionRef.current(action), []);
  const windows = useChatWindow({ snapshot, settings, onAction, onDetachedChange, onError: caught => update({ error: normalizeError(caught) }) });
  const routeAction = (action: ChatAction) => {
    if (action.type === 'detach') void windows.detach();
    else if (action.type === 'dock') void windows.dock();
    else if (action.type === 'focus') void windows.focus();
    else onAction(action);
  };
  return windows.detached ? null : <ChatView snapshot={snapshot} onAction={routeAction} />;
}
export default AgentPanel;
