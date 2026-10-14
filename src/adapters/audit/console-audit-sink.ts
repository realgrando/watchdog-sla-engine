/**
 * Console Audit Sink Adapter
 * Emits styled, informative log lines to the standard output.
 */

import {
  ISlaAuditSink,
  SlaTrackerResolvedEvent,
  SlaTrackerStartedEvent,
} from '../../interfaces';

export class ConsoleAuditSink implements ISlaAuditSink {
  private readonly prefix: string;

  constructor(prefix = '[Watchdog-SLA]') {
    this.prefix = prefix;
  }

  public onTrackerStarted(event: SlaTrackerStartedEvent): void {
    const started = event.startedAt.toISOString();
    const target = event.targetAt.toISOString();
    console.log(
      `\x1b[36m${this.prefix}\x1b[0m 🕒 \x1b[1mSTARTED\x1b[0m: [${event.policyName}] for Entity <${event.entityId}> | Budget: ${event.targetMinutes}m | Target: ${target} (Started: ${started})`
    );
  }

  public onTrackerResolved(event: SlaTrackerResolvedEvent): void {
    if (event.status === 'MET') {
      console.log(
        `\x1b[32m${this.prefix}\x1b[0m ✅ \x1b[32m\x1b[1mMET\x1b[0m: [${event.policyName}] for Entity <${event.entityId}> | Elapsed: ${event.formattedDuration}`
      );
    } else if (event.status === 'BREACHED') {
      console.log(
        `\x1b[31m${this.prefix}\x1b[0m ❌ \x1b[31m\x1b[1mBREACHED\x1b[0m: [${event.policyName}] for Entity <${event.entityId}> | Elapsed: ${event.formattedDuration} (Overdue by ${Math.floor((event.stoppedAt.getTime() - event.targetAt.getTime()) / 1000)}s)`
      );
    } else {
      console.log(
        `\x1b[33m${this.prefix}\x1b[0m ⚠️ \x1b[33m\x1b[1m${event.status}\x1b[0m: [${event.policyName}] for Entity <${event.entityId}>`
      );
    }
  }
}
