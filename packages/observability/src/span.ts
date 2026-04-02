import { generateSpanId } from '@swiftagent/shared';
import type { SpanType, SpanStatus, SpanError, SpanRecord } from './types.js';

export class Span {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly type: SpanType;
  readonly name: string;

  private startedAt: Date | null = null;
  private completedAt: Date | null = null;
  private durationMs: number | null = null;
  private metadata: Record<string, unknown> = {};
  private status: SpanStatus = 'ok';
  private error?: SpanError;

  constructor(
    spanId: string,
    traceId: string,
    parentSpanId: string | null,
    type: SpanType,
    name: string,
  ) {
    this.spanId = spanId;
    this.traceId = traceId;
    this.parentSpanId = parentSpanId;
    this.type = type;
    this.name = name;
  }

  start(): this {
    this.startedAt = new Date();
    return this;
  }

  end(status: SpanStatus, error?: Error): this {
    this.completedAt = new Date();
    this.status = status;
    if (this.startedAt) {
      this.durationMs = this.completedAt.getTime() - this.startedAt.getTime();
    }
    if (error) {
      this.error = { message: error.message, code: (error as { code?: string }).code };
    }
    return this;
  }

  addMetadata(partial: Record<string, unknown>): this {
    Object.assign(this.metadata, partial);
    return this;
  }

  startChild(type: SpanType, name: string): Span {
    const child = new Span(generateSpanId(), this.traceId, this.spanId, type, name);
    child.start();
    return child;
  }

  toRecord(): SpanRecord {
    const record: SpanRecord = {
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      traceId: this.traceId,
      type: this.type,
      name: this.name,
      startedAt: this.startedAt ?? new Date(),
      completedAt: this.completedAt,
      durationMs: this.durationMs,
      metadata: { ...this.metadata },
      status: this.status,
    };
    if (this.error) {
      record.error = this.error;
    }
    return record;
  }
}
