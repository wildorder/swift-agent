import { WebSocket } from 'ws';

/**
 * Minimal promise-based WebSocket client for the gateway integration suites.
 * Buffers every parsed JSON frame and lets tests await a frame matching a
 * predicate (or a `type`), with a bounded timeout so a hung run fails fast.
 */

export type WsFrame = Record<string, unknown> & { type?: string };

interface Waiter {
  pred: (frame: WsFrame) => boolean;
  resolve: (frame: WsFrame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface WsClient {
  readonly socket: WebSocket;
  /** All frames received so far, in order. */
  readonly frames: WsFrame[];
  send(message: unknown): void;
  /** Resolve with the first (buffered or future) frame matching `pred`. */
  waitFor(pred: (frame: WsFrame) => boolean, timeoutMs?: number): Promise<WsFrame>;
  /** Resolve with the first frame of the given `type`. */
  waitForType(type: string, timeoutMs?: number): Promise<WsFrame>;
  /** All buffered frames of a given type. */
  framesOfType(type: string): WsFrame[];
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function connectWs(url: string, openTimeoutMs = DEFAULT_TIMEOUT_MS): Promise<WsClient> {
  return new Promise<WsClient>((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames: WsFrame[] = [];
    const waiters: Waiter[] = [];

    const openTimer = setTimeout(() => {
      reject(new Error(`WebSocket did not open within ${openTimeoutMs}ms`));
      socket.terminate();
    }, openTimeoutMs);

    socket.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      let frame: WsFrame;
      try {
        frame = JSON.parse(text) as WsFrame;
      } catch {
        return;
      }
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.pred(frame)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(frame);
        }
      }
    });

    socket.on('error', (err: Error) => {
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(err);
      }
    });

    const client: WsClient = {
      socket,
      frames,
      send(message: unknown) {
        socket.send(JSON.stringify(message));
      },
      waitFor(pred, timeoutMs = DEFAULT_TIMEOUT_MS) {
        const existing = frames.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise<WsFrame>((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.timer === timer);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(new Error(`Timed out after ${timeoutMs}ms waiting for a matching WS frame`));
          }, timeoutMs);
          waiters.push({ pred, resolve: res, reject: rej, timer });
        });
      },
      waitForType(type, timeoutMs) {
        return client.waitFor((frame) => frame.type === type, timeoutMs);
      },
      framesOfType(type) {
        return frames.filter((frame) => frame.type === type);
      },
      close() {
        return new Promise<void>((res) => {
          if (socket.readyState === WebSocket.CLOSED) {
            res();
            return;
          }
          socket.once('close', () => res());
          socket.close();
        });
      },
    };

    socket.on('open', () => {
      clearTimeout(openTimer);
      resolve(client);
    });
  });
}
