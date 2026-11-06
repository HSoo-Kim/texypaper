import type { WorkspaceRef } from '../../contracts';
import type { Provider, ProviderStatus, Model } from './ProviderSettings';
import type { Proposal } from './ProposalReview';

export type AgentContext = { sources?: { path: string; startLine: number; endLine: number; text: string; truncated?: boolean }[]; pdfs?: { buildId: string; page: number; quote: string; truncated?: boolean }[]; attachments?: string[] };
export type HistoryRow = { id: string; role: 'user' | 'assistant' | 'tool'; text: string; provider?: string; taskId?: string };
export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'cancelling';
// View state only: never carries execution permission, disclosure or session credentials.
export type ChatReadingPosition = { provider: Provider; historyPage: string; following: boolean; scrollTop: number; anchor?: { id: string; inset: number } };
export type AgentError = { code: string; message: string };
export type ProviderConfiguration = {
  models: Model[];
  allowCustom: boolean;
  loading: boolean;
  instructions: boolean;
  executable: string;
  error: AgentError | null;
};

export type ExecutionPermission = 'deny' | 'ask' | 'session';
export type ExecutionRequest = {
  id: string;
  workspaceId: string;
  epoch: number;
  provider: string;
  taskId: string;
  summary: string;
  cwd: string;
  argv: string[];
  timeoutSeconds: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected' | 'timeout';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  error?: AgentError;
};

// The main window owns this state and every mutation, including while chat is detached.
export type ChatSnapshot = {
  workspace: WorkspaceRef;
  provider: Provider;
  model: string;
  reasoningEffort: string;
  account: ProviderStatus | null;
  configuration: ProviderConfiguration;
  prompt: string;
  disclosure: boolean;
  disclosureRemembered?: boolean;
  busy: boolean;
  status: AgentStatus;
  taskId: string;
  sessionId: string;
  loginUrl: string;
  error: AgentError | null;
  history: HistoryRow[];
  proposals: Proposal[];
  proposalBusy: string[];
  context: AgentContext;
  contextNotice?: 'invalid' | 'source-limit' | 'pdf-limit';
  composerFocus?: number;
  pages: string[];
  historyPage: string;
  historyLoading?: boolean;
  readingPosition?: ChatReadingPosition;
  settingsOpen: boolean;
  executionPermission: ExecutionPermission;
  executions: ExecutionRequest[];
};

export type ChatAction =
  | { type: 'prompt'; value: string }
  | { type: 'disclosure'; value: boolean }
  | { type: 'revoke-disclosure' }
  | { type: 'chat-font-size'; value: number }
  | { type: 'context-remove' | 'context-open'; kind: 'source' | 'pdf'; index: number }
  | { type: 'provider'; value: Provider }
  | { type: 'model'; value: string }
  | { type: 'reasoning'; value: string }
  | { type: 'executable'; value: string }
  | { type: 'settings'; value: boolean }
  | { type: 'history'; page: string }
  | { type: 'reading-position'; value: ChatReadingPosition }
  | { type: 'decide'; id: string; decision: 'apply' | 'reject' }
  | { type: 'undo'; id: string }
  | { type: 'execution-permission'; value: ExecutionPermission; acknowledged?: boolean }
  | { type: 'execution-decide'; id: string; decision: 'approve' | 'reject' }
  | { type: 'execution-cancel'; id: string }
  | { type: 'send' | 'cancel' | 'refresh' | 'login' | 'open-login' | 'save-executable' | 'dismiss-error' | 'detach' | 'dock' | 'focus' };

export type ChatViewProps = { snapshot: ChatSnapshot; onAction: (action: ChatAction) => void; detached?: boolean; fontSize?: number };
