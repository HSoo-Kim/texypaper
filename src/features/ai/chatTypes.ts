import type { WorkspaceRef } from '../../contracts';
import type { Provider, ProviderStatus, Model } from './ProviderSettings';
import type { Proposal } from './ProposalReview';

export type AgentContext = { source?: { path: string; startLine?: number; endLine?: number; text?: string }; pdf?: { buildId: string; quote: string; page?: number }; attachments?: string[] };
export type HistoryRow = { id: string; role: 'user' | 'assistant' | 'tool'; text: string; provider?: string; taskId?: string };
export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'cancelling';
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
  pages: string[];
  historyPage: string;
  settingsOpen: boolean;
  executionPermission: ExecutionPermission;
  executions: ExecutionRequest[];
};

export type ChatAction =
  | { type: 'prompt'; value: string }
  | { type: 'disclosure'; value: boolean }
  | { type: 'provider'; value: Provider }
  | { type: 'model'; value: string }
  | { type: 'reasoning'; value: string }
  | { type: 'executable'; value: string }
  | { type: 'settings'; value: boolean }
  | { type: 'history'; page: string }
  | { type: 'decide'; id: string; decision: 'apply' | 'reject' }
  | { type: 'undo'; id: string }
  | { type: 'execution-permission'; value: ExecutionPermission; acknowledged?: boolean }
  | { type: 'execution-decide'; id: string; decision: 'approve' | 'reject' }
  | { type: 'execution-cancel'; id: string }
  | { type: 'send' | 'cancel' | 'refresh' | 'login' | 'open-login' | 'save-executable' | 'dismiss-error' | 'detach' | 'dock' | 'focus' };

export type ChatViewProps = { snapshot: ChatSnapshot; onAction: (action: ChatAction) => void; detached?: boolean };
