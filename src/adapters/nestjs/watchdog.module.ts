/**
 * NestJS Dynamic Module for Watchdog SLA Engine
 */

import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { ISlaAuditSink, ISlaStorageDriver } from '../../interfaces';
import {
  WATCHDOG_AUDIT_TOKEN,
  WATCHDOG_STORAGE_TOKEN,
} from './tokens';
import { WatchdogSlaService } from './watchdog.service';

export interface WatchdogModuleOptions {
  storageDriver: ISlaStorageDriver;
  auditSink?: ISlaAuditSink;
}

export interface WatchdogAsyncModuleOptions {
  useFactory: (
    ...args: any[]
  ) => Promise<WatchdogModuleOptions> | WatchdogModuleOptions;
  inject?: any[];
}

@Global()
@Module({})
export class WatchdogSlaModule {
  public static forRoot(options: WatchdogModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: WATCHDOG_STORAGE_TOKEN,
        useValue: options.storageDriver,
      },
      {
        provide: WATCHDOG_AUDIT_TOKEN,
        useValue: options.auditSink,
      },
      WatchdogSlaService,
    ];

    return {
      module: WatchdogSlaModule,
      providers,
      exports: [WatchdogSlaService, WATCHDOG_STORAGE_TOKEN],
    };
  }

  public static forRootAsync(options: WatchdogAsyncModuleOptions): DynamicModule {
    const asyncOptionsProvider: Provider = {
      provide: 'WATCHDOG_ASYNC_OPTIONS',
      useFactory: options.useFactory,
      inject: options.inject || [],
    };

    const storageProvider: Provider = {
      provide: WATCHDOG_STORAGE_TOKEN,
      useFactory: (opts: WatchdogModuleOptions) => opts.storageDriver,
      inject: ['WATCHDOG_ASYNC_OPTIONS'],
    };

    const auditProvider: Provider = {
      provide: WATCHDOG_AUDIT_TOKEN,
      useFactory: (opts: WatchdogModuleOptions) => opts.auditSink,
      inject: ['WATCHDOG_ASYNC_OPTIONS'],
    };

    return {
      module: WatchdogSlaModule,
      imports: [],
      providers: [
        asyncOptionsProvider,
        storageProvider,
        auditProvider,
        WatchdogSlaService,
      ],
      exports: [WatchdogSlaService, WATCHDOG_STORAGE_TOKEN],
    };
  }
}
