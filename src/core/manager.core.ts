import {
  Injectable,
  LogLevel,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { MediaNoopStorage } from '@waha/core/media/MediaNoopStorage';
import { getPinoLogLevel, LoggerBuilder } from '@waha/utils/logging';
import { promiseTimeout, sleep } from '@waha/utils/promiseTimeout';
import { EventEmitter } from 'events';
import { PinoLogger } from 'nestjs-pino';

import { WhatsappConfigService } from '../config.service';
import {
  WAHAEngine,
  WAHAEvents,
  WAHASessionStatus,
} from '../structures/enums.dto';
import {
  ProxyConfig,
  SessionConfig,
  SessionDetailedInfo,
  SessionDTO,
  SessionInfo,
} from '../structures/sessions.dto';
import { WebhookConfig } from '../structures/webhooks.config.dto';
import { SessionManager } from './abc/manager.abc';
import { SessionParams, WhatsappSession } from './abc/session.abc';
import { EngineConfigService } from './config/EngineConfigService';
import { WhatsappSessionNoWebCore } from './engines/noweb/session.noweb.core';
import { WhatsappSessionWebJSCore } from './engines/webjs/session.webjs.core';
import { DOCS_URL } from './exceptions';
import { getProxyConfig } from './helpers.proxy';
import { MediaManagerCore } from './media/MediaManagerCore';
import { LocalSessionAuthRepository } from './storage/LocalSessionAuthRepository';
import { LocalStoreCore } from './storage/LocalStoreCore';
import { WebhookConductorCore } from './webhooks.core';

export class OnlyDefaultSessionIsAllowed extends UnprocessableEntityException {
  constructor() {
    super(
      `WAHA Core support only 'default' session. If you want to run more then one WhatsApp account - please get WAHA PLUS version. Check this out: ${DOCS_URL}`,
    );
  }
}
enum DefaultSessionStatus {
  REMOVED = undefined,
  STOPPED = null,
}

@Injectable()
export class SessionManagerCore extends SessionManager {
  SESSION_STOP_TIMEOUT = 3000;

  // session - exists and running (or failed or smth)
  // null - stopped
  // undefined - removed
  private session: WhatsappSession | DefaultSessionStatus;
  private sessionConfig?: SessionConfig;
  DEFAULT = 'default';

  // @ts-ignore
  protected WebhookConductorClass = WebhookConductorCore;
  protected readonly EngineClass: typeof WhatsappSession;

  constructor(
    private config: WhatsappConfigService,
    private engineConfigService: EngineConfigService,
    private log: PinoLogger,
  ) {
    super();
    this.events = new EventEmitter();
    this.session = DefaultSessionStatus.STOPPED;
    this.sessionConfig = null;
    this.log.setContext(SessionManagerCore.name);
    const engineName = this.engineConfigService.getDefaultEngineName();
    this.EngineClass = this.getEngine(engineName);
    this.store = new LocalStoreCore(engineName.toLowerCase());
    this.sessionAuthRepository = new LocalSessionAuthRepository(this.store);
    this.startPredefinedSessions();
  }

  protected startPredefinedSessions() {
    const startSessions = this.config.startSessions;
    startSessions.forEach((sessionName) => {
      this.start(sessionName);
    });
  }

  protected getEngine(engine: WAHAEngine): typeof WhatsappSession {
    if (engine === WAHAEngine.WEBJS) {
      return WhatsappSessionWebJSCore;
    } else if (engine === WAHAEngine.NOWEB) {
      return WhatsappSessionNoWebCore;
    } else {
      throw new NotFoundException(`Unknown whatsapp engine '${engine}'.`);
    }
  }

  private onlyDefault(name: string) {
    if (name !== this.DEFAULT) {
      throw new OnlyDefaultSessionIsAllowed();
    }
  }

  async beforeApplicationShutdown(signal?: string) {
    if (!this.session) {
      return;
    }
    await this.stop(this.DEFAULT, true);
  }

  //
  // API Methods
  //
  async exists(name: string): Promise<boolean> {
    this.onlyDefault(name);
    return this.session !== DefaultSessionStatus.REMOVED;
  }

  isRunning(name: string): boolean {
    this.onlyDefault(name);
    return !!this.session;
  }

  async upsert(name: string, config?: SessionConfig): Promise<void> {
    this.onlyDefault(name);
    this.sessionConfig = config;
  }

  async start(name: string): Promise<SessionDTO> {
    this.onlyDefault(name);
    if (this.session) {
      throw new UnprocessableEntityException(
        `Session '${this.DEFAULT}' is already started.`,
      );
    }
    this.log.info(`'${name}' - starting session...`);
    const mediaManager = new MediaManagerCore(
      new MediaNoopStorage(),
      this.config.mimetypes,
    );
    const logger = this.log.logger.child({ session: name });
    logger.level = getPinoLogLevel(this.sessionConfig?.debug);
    const loggerBuilder: LoggerBuilder = logger;

    const webhook = new this.WebhookConductorClass(loggerBuilder);
    const proxyConfig = this.getProxyConfig();
    const sessionConfig: SessionParams = {
      name,
      mediaManager,
      loggerBuilder,
      printQR: this.engineConfigService.shouldPrintQR,
      sessionStore: this.store,
      proxyConfig: proxyConfig,
      sessionConfig: this.sessionConfig,
    };
    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new this.EngineClass(sessionConfig);
    this.session = session;

    // configure webhooks
    const webhooks = this.getWebhooks();
    webhook.configure(session, webhooks);

    // configure events
    session.events.on(
      WAHAEvents.SESSION_STATUS,
      this.handleSessionEvent(WAHAEvents.SESSION_STATUS, session),
    );

    // start session
    await session.start();
    logger.info('Session has been started.');
    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  async stop(name: string, silent: boolean): Promise<void> {
    this.onlyDefault(name);
    if (!this.isRunning(name)) {
      this.log.debug(`Session is not running.`, { session: name });
      return;
    }

    this.log.info(`Stopping session...`, { session: name });
    try {
      const session = this.getSession(name);
      await session.stop();
    } catch (err) {
      this.log.warn(`Error while stopping session '${name}'`);
      if (!silent) {
        throw err;
      }
    }
    this.log.info(`Session has been stopped.`, { session: name });
    this.session = DefaultSessionStatus.STOPPED;
    await sleep(this.SESSION_STOP_TIMEOUT);
  }

  async logout(name: string): Promise<void> {
    this.onlyDefault(name);
    await this.sessionAuthRepository.clean(name);
  }

  async delete(name: string): Promise<void> {
    this.onlyDefault(name);
    this.session = DefaultSessionStatus.REMOVED;
    this.sessionConfig = undefined;
  }

  /**
   * Combine per session and global webhooks
   */
  private getWebhooks() {
    let webhooks: WebhookConfig[] = [];
    if (this.sessionConfig?.webhooks) {
      webhooks = webhooks.concat(this.sessionConfig.webhooks);
    }
    const globalWebhookConfig = this.config.getWebhookConfig();
    if (globalWebhookConfig) {
      webhooks.push(globalWebhookConfig);
    }
    return webhooks;
  }

  /**
   * Get either session's or global proxy if defined
   */
  protected getProxyConfig(): ProxyConfig | undefined {
    if (this.sessionConfig?.proxy) {
      return this.sessionConfig.proxy;
    }
    if (!this.session) {
      return undefined;
    }
    const sessions = { [this.DEFAULT]: this.session as WhatsappSession };
    return getProxyConfig(this.config, sessions, this.DEFAULT);
  }

  getSession(name: string): WhatsappSession {
    this.onlyDefault(name);
    const session = this.session;
    if (!session) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'.\n` +
          `Please start it first by using POST /api/sessions/${name}/start request`,
      );
    }
    return session as WhatsappSession;
  }

  async getSessions(all: boolean): Promise<SessionInfo[]> {
    if (this.session === DefaultSessionStatus.STOPPED && all) {
      return [
        {
          name: this.DEFAULT,
          status: WAHASessionStatus.STOPPED,
          config: this.sessionConfig,
          me: null,
        },
      ];
    }
    if (this.session === DefaultSessionStatus.REMOVED && all) {
      return [];
    }
    if (!this.session && !all) {
      return [];
    }

    const session = this.session as WhatsappSession;
    const me = session?.getSessionMeInfo();
    return [
      {
        name: session.name,
        status: session.status,
        config: session.sessionConfig,
        me: me,
      },
    ];
  }

  private async fetchEngineInfo() {
    const session = this.session as WhatsappSession;
    // Get engine info
    let engineInfo = {};
    if (session) {
      try {
        engineInfo = await promiseTimeout(1000, session.getEngineInfo());
      } catch (error) {
        this.log.warn(
          { session: session.name, error: `${error}` },
          'Error while getting engine info',
        );
      }
    }
    const engine = {
      engine: session?.engine,
      ...engineInfo,
    };
    return engine;
  }

  async getSessionInfo(name: string): Promise<SessionDetailedInfo | null> {
    if (name !== this.DEFAULT) {
      return null;
    }
    const sessions = await this.getSessions(true);
    if (sessions.length === 0) {
      return null;
    }
    const session = sessions[0];
    const engine = await this.fetchEngineInfo();
    return { ...session, engine: engine };
  }
}
