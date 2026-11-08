import { setTimeout as delay } from 'node:timers/promises';
import { bridgeCall } from './ipc.mjs';

export class DshClient {
  constructor(root) { this.root = root; }
  call(op, params, timeout) { return bridgeCall(this.root, op, params, timeout); }
  async resume(sessionId) { return await this.call('resume', { sessionId }); }
  async inspect(sessionId) { return await this.call('inspect', { sessionId }); }
  async state(sessionId) { return await this.call('state', { sessionId }); }
  async cancel(sessionId) { return await this.call('cancel', { sessionId }); }
  async wait(task, deadline, isPaused = () => false) {
    let settled = 0;
    let notifiedInput = false;
    while (Date.now() < deadline) {
      if (isPaused()) throw new Error('任务已请求暂停');
      const state = await this.state(task.dshSessionId);
      if (state.pendingInput.length && !notifiedInput) { console.log(`[${task.id}] DSH 等待人工处理：${state.pendingInput.join('、')}，请查看 WebUI。`); notifiedInput = true; }
      if (!state.pendingInput.length) notifiedInput = false;
      if (state.observed?.error) throw new Error(`DSH 事件订阅中断：${state.observed.error}`);
      const end = state.observed?.ends?.find(item => item.turn === state.observed.matchedTurn);
      const quiet = !state.running && state.queue !== null && state.queue.length === 0 && !state.pendingInput.length && !state.jobs.some(job => ['running', 'stopping'].includes(job.status));
      if (!end && quiet && state.observed?.ends?.length) {
        const last = state.observed.ends.at(-1);
        throw new Error(`DSH 回合无法关联到本次请求：${last.reason?.error?.message ?? last.reason?.kind ?? '未知原因'}`);
      }
      if (end && quiet) {
        if (end.reason?.kind !== 'completed') throw new Error(`DSH 回合结束：${end.reason?.kind ?? '未知'}${end.reason?.error?.message ? `，${end.reason.error.message}` : ''}`);
        // A queued follow-up may create further turns; wait for those to settle too.
        const latest = state.observed.ends.at(-1);
        if (latest?.reason?.kind !== 'completed') throw new Error(`DSH 后续回合结束：${latest.reason?.kind ?? '未知'}`);
        if (++settled >= 2) return state;
      } else settled = 0;
      await delay(400);
    }
    throw new Error('DSH 阶段超时或仍在等待人工输入');
  }
}
