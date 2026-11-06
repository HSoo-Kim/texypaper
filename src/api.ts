import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppError, AppEvent, WorkspaceRef } from './contracts';

export function normalizeError(error: unknown): AppError {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) return error as AppError;
  if (typeof error === 'string') { try { return normalizeError(JSON.parse(error)); } catch { return { code: 'NATIVE_ERROR', message: error, retryable: false }; } }
  return { code: 'NATIVE_ERROR', message: error instanceof Error ? error.message : String(error), retryable: false };
}
export async function request<T>(command: string, workspace: WorkspaceRef, args: unknown = {}): Promise<T> {
  try { return await invoke<T>(command, { workspaceId: workspace.id, epoch: workspace.epoch, args }); }
  catch (error) { throw normalizeError(error); }
}
export async function native<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try { return await invoke<T>(command, args); } catch (error) { throw normalizeError(error); }
}
export function workspaceEvents(workspace: WorkspaceRef, receive: (event: AppEvent) => void) {
  let sequence = -1;
  return listen<AppEvent>('texypaper:event', ({ payload }) => {
    if (payload.workspaceId !== workspace.id || payload.epoch !== workspace.epoch || payload.sequence <= sequence) return;
    sequence = payload.sequence; receive(payload);
  });
}
