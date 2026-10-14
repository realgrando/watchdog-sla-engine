/**
 * EventEmitter Audit Sink Adapter
 * Dispatches strongly-typed events to Node.js EventEmitter or NestJS EventEmitter2
 */

import {
  ISlaAuditSink,
  SlaTrackerResolvedEvent,
  SlaTrackerStartedEvent,
} from '../../interfaces';

export interface IEmitterTarget {
  emit(event: string, ...args: unknown[]): boolean;
}

export class EventEmitterAuditSink implements ISlaAuditSink {
  private readonly emitter: IEmitterTarget;

  constructor(emitter: IEmitterTarget) {
    this.emitter = emitter;
  }

  public onTrackerStarted(event: SlaTrackerStartedEvent): void {
    this.emitter.emit('sla.tracker.started', event);
  }

  public onTrackerResolved(event: SlaTrackerResolvedEvent): void {
    this.emitter.emit('sla.tracker.resolved', event);
    if (event.status === 'MET') {
      this.emitter.emit('sla.tracker.met', event);
    } else if (event.status === 'BREACHED') {
      this.emitter.emit('sla.tracker.breached', event);
    }
  }
}
