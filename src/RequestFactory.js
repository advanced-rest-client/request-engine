/* eslint-disable class-methods-use-this */
import { ActionsRunner } from '@advanced-rest-client/arc-actions';
import { ArcModelEvents } from '@advanced-rest-client/arc-models';
import * as Events from '@advanced-rest-client/arc-events';
import { VariablesProcessor } from '@advanced-rest-client/arc-environment';
import { ModulesRegistry } from './ModulesRegistry.js';
import ExecutionResponse from './ExecutionResponse.js';

/** @typedef {import('@advanced-rest-client/arc-types').ArcRequest.ArcEditorRequest} ArcEditorRequest */
/** @typedef {import('@advanced-rest-client/arc-types').ArcResponse.Response} Response */
/** @typedef {import('@advanced-rest-client/arc-types').ArcResponse.ErrorResponse} ErrorResponse */
/** @typedef {import('@advanced-rest-client/arc-types').ArcRequest.TransportRequest} TransportRequest */
/** @typedef {import('@advanced-rest-client/arc-models').EnvironmentStateDetail} EnvironmentStateDetail */
/** @typedef {import('./types').RegisteredRequestModule} RegisteredRequestModule */
/** @typedef {import('./types').RegisteredResponseModule} RegisteredResponseModule */
/** @typedef {import('./types').ExecutionContext} ExecutionContext */
/** @typedef {import('./types').ExecutionEvents} ExecutionEvents */
/** @typedef {import('./types').ExecutionStore} ExecutionStore */
/** @typedef {import('./types').RequestProcessOptions} RequestProcessOptions */
/** @typedef {import('./types').ResponseProcessOptions} ResponseProcessOptions */

/**
 * The class that is responsible for pre-processing and post-processing the request.
 * 
 * Pre processing part evaluates variables on the request object and then executes request plugins.
 * Post processing 
 */
export class RequestFactory {
  /**
   * 
   * @param {EventTarget} eventsTarget The reference to a DOM object that is the event target to ARC events.
   * @param {any} jexl A reference to an instance of Jexl library
   */
  constructor(eventsTarget, jexl) {
    this.eventsTarget = eventsTarget;
    this.jexl = jexl;

    this.actions = new ActionsRunner({
      jexl,
      eventsTarget,
    });

    /**
     * @type {Map<string, AbortController>}
     */
    this.abortControllers = new Map();
  }

  /**
   * Aborts the execution of the current action.
   * @param {string} id
   */
  abort(id) {
    const controller = this.abortControllers.get(id);
    if (!controller) {
      return;
    }
    controller.abort();
    this.abortControllers.delete(id);
  }

  /**
   * Takes the ARC editor request object and runs the request logic.
   * 
   * @param {ArcEditorRequest} request ARC request object generated by the request editor.
   * @param {RequestProcessOptions=} [options={}] Optional processing options.
   * @returns {Promise<ArcEditorRequest|null>} The request object, possible altered by the actions and modules. `null` when 
   * the execution was aborted by any of the scripts.
   */
  async processRequest(request, options={}) {
    const abortController = new AbortController();
    const { signal } = abortController;
    await this.actions.processRequestActions(request, {
      evaluateVariables: options.evaluateVariables,
    });

    const environment = await ArcModelEvents.Environment.current(this.eventsTarget);
    if (options.evaluateVariables !== false) {
      const processor = new VariablesProcessor(this.jexl, environment.variables);
      // @ts-ignore
      await processor.evaluateVariables(request.request, ['url', 'headers', 'method', 'payload']);
    }

    const modules = ModulesRegistry.get(ModulesRegistry.request);
    for (const [id, main] of modules) {
      if (signal.aborted) {
        this.abortControllers.delete(request.id);
        return null;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await this.executeRequestModule(request, id, /** @type RegisteredRequestModule */ (main), environment, signal);
      if (result === ExecutionResponse.ABORT) {
        return null;
      }
    }
    this.abortControllers.set(request.id, abortController);
    return request;
  }

  /**
   * Processes ARC transport response
   * 
   * @param {ArcEditorRequest} request ARC request object generated by the request editor.
   * @param {TransportRequest} executed The request reported by the transport library
   * @param {Response|ErrorResponse} response ARC response object.
   * @param {ResponseProcessOptions=} [options={}] Optional processing options.
   * @returns {Promise<void>} A promise resolved when actions were performed.
   */
  async processResponse(request, executed, response, options={}) {
    let abortController = this.abortControllers.get(request.id);
    if (!abortController) {
      abortController = new AbortController();
    }
    const { signal } = abortController;
    await this.actions.processResponseActions(request, executed, response, {
      evaluateVariables: options.evaluateVariables,
    });
    const modules = ModulesRegistry.get(ModulesRegistry.response);
    const environment = await ArcModelEvents.Environment.current(this.eventsTarget);
    for (const [id, main] of modules) {
      if (signal.aborted) {
        this.abortControllers.delete(request.id);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await this.executeResponseModule(request, executed, response, id, /** @type RegisteredResponseModule */ (main), environment, signal);
      if (result === ExecutionResponse.ABORT) {
        this.abortControllers.delete(request.id);
        return;
      }
    }
    this.abortControllers.delete(request.id);
  }

  /**
   * @param {ArcEditorRequest} request ARC request object generated by the request editor.
   * @param {string} id The id of the module being executed
   * @param {RegisteredRequestModule} info The module to execute
   * @param {EnvironmentStateDetail} environment The current environment
   * @param {AbortSignal} signal The abort signal
   * @returns {Promise<number>}
   */
  async executeRequestModule(request, id, info, environment, signal) {
    const context = await this.buildExecutionContext(info.permissions, environment);
    let result;
    try {
      result = await info.fn(request, context, signal);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(e);
      const message = `Request module ${id} reported error: ${e.message}`;
      throw new Error(message);
    }
    return result;
  }

  /**
   * @param {ArcEditorRequest} request ARC request object generated by the request editor.
   * @param {TransportRequest} executed The request reported by the transport library
   * @param {Response|ErrorResponse} response ARC response object.
   * @param {string} id The id of the module being executed
   * @param {RegisteredResponseModule} info The module to execute
   * @param {EnvironmentStateDetail} environment The current environment
   * @param {AbortSignal} signal The abort signal
   * @returns {Promise<number>}
   */
  async executeResponseModule(request, executed, response, id, info, environment, signal) {
    const context = await this.buildExecutionContext(info.permissions, environment);
    let result;
    try {
      result = await info.fn(request, executed, response, context, signal);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(e);
      const message = `Request module ${id} reported error: ${e.message}`;
      throw new Error(message);
    }
    return result;
  }

  /**
   * Builds module execution context
   * @param {string[]} permissions 
   * @param {EnvironmentStateDetail} environment 
   * @returns {Promise<readonly ExecutionContext>}
   */
  async buildExecutionContext(permissions, environment) {
    const result = /** @type ExecutionContext */ ({
      eventsTarget: this.eventsTarget,
    });
    const hasEnvironment = permissions.includes('environment');
    if (hasEnvironment) {
      result.environment = environment;
    }
    if (permissions.includes('events')) {
      result.Events = this.prepareExecutionEvents();
    }
    if (permissions.includes('store')) {
      result.Store = this.prepareExecutionStore(hasEnvironment);
    }
    return Object.freeze(result);
  }

  /**
   * Prepares a map of events passed to the module
   * 
   * @returns {readonly ExecutionEvents}
   */
  prepareExecutionEvents() {
    const result = /** @type ExecutionEvents */ ({
      ArcNavigationEvents: Events.ArcNavigationEvents,
      SessionCookieEvents: Events.SessionCookieEvents,
      EncryptionEvents: Events.EncryptionEvents,
      GoogleDriveEvents: Events.GoogleDriveEvents,
      ProcessEvents: Events.ProcessEvents,
      WorkspaceEvents: Events.WorkspaceEvents,
      RequestEvents: Events.RequestEvents,
      AuthorizationEvents: Events.AuthorizationEvents,
      ConfigEvents: Events.ConfigEvents,
    });
    return Object.freeze(result);
  }

  /**
   * @param {boolean} hasEnvironment Whether to add environment events
   * @returns {readonly ExecutionStore}
   */
  prepareExecutionStore(hasEnvironment) {
    const result = /** @type ExecutionStore */ ({
      AuthData: ArcModelEvents.AuthData,
      ClientCertificate: ArcModelEvents.ClientCertificate,
      HostRules: ArcModelEvents.HostRules,
      Project: ArcModelEvents.Project,
      Request: ArcModelEvents.Request,
      RestApi: ArcModelEvents.RestApi,
      UrlHistory: ArcModelEvents.UrlHistory,
      UrlIndexer: ArcModelEvents.UrlIndexer,
      WSUrlHistory: ArcModelEvents.WSUrlHistory,
    });
    if (hasEnvironment) {
      result.Environment = ArcModelEvents.Environment;
      result.Variable = ArcModelEvents.Variable;
    }
    return Object.freeze(result);
  }
}
