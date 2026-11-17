import { isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';
import type { ChatAction, ChatSnapshot } from './chatTypes';
import { isChatAction } from './chatBridge';
import { appendWritingTask, MAX_WRITING_PROMPT_LENGTH, WRITING_TASKS, type WritingTask } from './writingTasks';

// Exercise the actual composer handlers without a DOM dependency. Only the
// parent view runs: child components remain React elements, not mocked UIs.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, locale: 'en' as 'ko' | 'en' }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof ReactModule>(),
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.values)) hooks.values[slot] = initial;
    return [hooks.values[slot], (value: unknown) => { hooks.values[slot] = typeof value === 'function' ? value(hooks.values[slot]) : value; }];
  },
  useRef: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.values)) hooks.values[slot] = { current: initial };
    return hooks.values[slot];
  },
  useEffect: () => {},
}));
vi.mock('../../ui/paneZoom', () => ({ usePaneZoom: () => {}, usePreventBrowserZoom: () => {}, zoomKeyDirection: () => 0 }));
vi.mock('../../ui/i18n', () => ({ useI18n: () => ({ locale: hooks.locale, t: (ko: string, en?: string) => hooks.locale === 'ko' ? ko : en ?? ko }) }));

type Element = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Element['props']>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function snapshot(): ChatSnapshot {
  return {
    workspace: { id: 'workspace', epoch: 3, environmentId: 'local', root: '/paper' },
    provider: 'codex', model: 'model', reasoningEffort: '', account: { provider: 'codex', available: true, loggedIn: true, subscription: true },
    configuration: { models: [{ id: 'model', label: 'Model', reasoningEfforts: [] }], allowCustom: false, loading: false, instructions: false, executable: '', error: null },
    prompt: '  Keep 42% and \\cite{original}.\n', busy: false, status: 'idle', taskId: '', sessionId: '', loginUrl: '', error: null,
    history: [], proposals: [], proposalBusy: [], context: { sources: [{ path: 'main.tex', startLine: 1, endLine: 1, text: 'Original source' }], pdfs: [{ buildId: 'build', page: 2, quote: 'Original PDF quote' }] },
    pages: [], historyPage: 'current.jsonl', settingsOpen: false, executionPermission: 'ask', executions: [],
  };
}
function composer(detached = false) {
  hooks.values = []; hooks.cursor = 0;
  let current = snapshot();
  const actions: ChatAction[] = [];
  let tree: ReactNode;
  const render = () => {
    hooks.cursor = 0;
    tree = ChatView({ snapshot: current, detached, onAction: action => {
      actions.push(action);
      if (action.type === 'prompt') current = { ...current, prompt: action.value };
    } });
  };
  const find = (testid: string) => {
    const node = elements(tree).find(element => element.props['data-testid'] === testid);
    if (!node) throw new Error(`Missing consumer control: ${testid}`);
    return node;
  };
  render();
  return {
    actions, find,
    current: () => current,
    update: (change: Partial<ChatSnapshot>) => { current = { ...current, ...change }; render(); },
    choose: (id: WritingTask['id']) => {
      (find('agent-writing-task').props.onChange as (event: { target: { value: string } }) => void)({ target: { value: id } });
      render();
    },
    append: () => { (find('agent-writing-task-append').props.onClick as () => void)(); render(); },
  };
}

beforeEach(() => { hooks.locale = 'en'; });

describe('writing-task composer consumer', () => {
  it.each(['ko', 'en'] as const)('appends every selected task once in %s, preserving drafts and attachments in either window', locale => {
    hooks.locale = locale;
    for (const detached of [false, true]) for (const task of WRITING_TASKS) {
      const view = composer(detached);
      const original = view.current();
      expect(view.find('agent-writing-task-append').props.disabled).toBe(true);
      expect(elements(view.find('agent-writing-task')).filter(node => node.type === 'option').map(node => node.props.children)).toContain(task.label[locale]);
      view.choose(task.id);
      expect(view.actions).toEqual([]);
      expect(view.current().prompt).toBe(original.prompt);
      expect(view.find('agent-writing-task-append').props.children).toBe(locale === 'ko' ? '초안에 덧붙이기' : 'Append to draft');
      expect(view.find('agent-writing-task-append').props.type).toBe('button');
      view.append();
      expect(view.actions).toEqual([{ type: 'prompt', value: appendWritingTask(original.prompt, task, locale) }]);
      expect(isChatAction(view.actions[0])).toBe(true);
      expect(view.current().prompt.startsWith(`${original.prompt}\n\n`)).toBe(true);
      expect(view.current().context).toBe(original.context);
      expect(view.find('agent-attachments')).toBeDefined();
      expect(view.find('agent-prompt').props.value).toBe(view.current().prompt);
      expect(view.find('agent-writing-task').props.value).toBe('');
      view.append();
      expect(view.actions).toHaveLength(1);
      expect(view.actions.some(action => action.type === 'send')).toBe(false);
      expect(view.find('agent-send').props.type).toBe('submit');
    }
  });

  it('uses the latest edited draft, not the draft from task selection', () => {
    const view = composer(true);
    view.choose('english');
    const edited = 'New draft: $x_i = 17$ and \\cite{unchanged}.\n';
    (view.find('agent-prompt').props.onChange as (event: { target: { value: string } }) => void)({ target: { value: edited } });
    view.update({});
    view.append();
    expect(view.current().prompt).toBe(appendWritingTask(edited, WRITING_TASKS[1], 'en'));
    expect(view.actions.map(action => action.type)).toEqual(['prompt', 'prompt']);
  });

  it.each(['ko', 'en'] as const)('shows overflow and refuses the append without truncating in %s', locale => {
    hooks.locale = locale;
    const view = composer(true);
    const original = '😀'.repeat(MAX_WRITING_PROMPT_LENGTH / 2);
    view.update({ prompt: original });
    view.choose('shorten');
    expect(view.find('agent-writing-task-error').props.role).toBe('alert');
    expect(view.find('agent-writing-task-error').props.children).toContain('65,536');
    expect(view.find('agent-writing-task-append').props.disabled).toBe(true);
    expect(view.find('agent-prompt').props.maxLength).toBe(MAX_WRITING_PROMPT_LENGTH);
    view.append();
    expect(view.actions).toEqual([]);
    expect(view.current().prompt).toBe(original);
    view.update({ prompt: 'Shorter draft' });
    expect(view.find('agent-writing-task-append').props.disabled).toBe(false);
    view.append();
    expect(view.actions).toHaveLength(1);
  });

  it('disables selection and guards append while busy, then allows it when idle', () => {
    const view = composer();
    view.choose('reviewer-response');
    const original = view.current().prompt;
    view.update({ busy: true, status: 'running' });
    expect(view.find('agent-writing-task').props.disabled).toBe(true);
    expect(view.find('agent-writing-task-append').props.disabled).toBe(true);
    view.append();
    expect(view.actions).toEqual([]);
    expect(view.current().prompt).toBe(original);
    view.update({ busy: false, status: 'completed' });
    view.append();
    expect(view.actions).toHaveLength(1);
  });
});

describe('writing-task prompt boundaries', () => {
  it.each(['ko', 'en'] as const)('accepts the exact existing limit and rejects one extra UTF-16 unit in %s', locale => {
    for (const task of WRITING_TASKS) {
      const instructions = appendWritingTask('', task, locale)!;
      expect(instructions).toBe(`${task.instructions[locale]}\n\n${locale === 'ko' ? '소스 수정은 검토할 제안으로만 제시하고 직접 적용하지 마세요.' : 'Present source edits only as proposals for review; do not apply them directly.'}`);
      const draft = 'x'.repeat(MAX_WRITING_PROMPT_LENGTH - instructions.length - 2);
      const exact = appendWritingTask(draft, task, locale)!;
      expect(exact).toHaveLength(MAX_WRITING_PROMPT_LENGTH);
      expect(isChatAction({ type: 'prompt', value: exact })).toBe(true);
      expect(appendWritingTask(`${draft}x`, task, locale)).toBeNull();
    }
  });
});
