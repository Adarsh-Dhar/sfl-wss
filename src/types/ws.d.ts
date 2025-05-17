declare module 'ws' {
  export = WebSocket;
  
  class WebSocket extends NodeJS.EventEmitter {
    constructor(address: string, options?: WebSocket.ClientOptions);
    on(event: 'message', listener: (data: Buffer | string | ArrayBuffer | Buffer[]) => void): this;
    on(event: 'open', listener: () => void): this;
    on(event: 'close', listener: (code: number, reason: string) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    send(data: any, callback?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    readonly readyState: number;
    readonly CONNECTING: number;
    readonly OPEN: number;
    readonly CLOSING: number;
    readonly CLOSED: number;
  }
  
  namespace WebSocket {
    export interface ClientOptions {
      protocol?: string;
      headers?: { [key: string]: string };
      agent?: any;
      timeout?: number;
    }
    
    export class Server extends NodeJS.EventEmitter {
      constructor(options: ServerOptions, callback?: () => void);
      on(event: 'connection', listener: (socket: WebSocket, request: any) => void): this;
      on(event: 'error', listener: (error: Error) => void): this;
      on(event: 'close', listener: () => void): this;
      on(event: string, listener: (...args: any[]) => void): this;
      close(callback?: () => void): void;
    }
    
    export interface ServerOptions {
      host?: string;
      port?: number;
      server?: any;
      path?: string;
    }
    
    export const CONNECTING: number;
    export const OPEN: number;
    export const CLOSING: number;
    export const CLOSED: number;
  }
}
