import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { ServiceCreateOpts, ServiceDescriptor } from "./lifecycle.js";

const execAsync = promisify(exec);

interface HotReloadOpts {
  buildCommand: string;
  swap: (serviceName: string, opts: { cwd: string; logger?: AdapterLogger }) => Promise<void>;
  sessionServiceName: string;
  cwd: string;
}

/**
 * Create a hot reload service descriptor for automatic code rebuilding and session swapping.
 * @param opts - Configuration options for hot reload behavior
 * @returns A service descriptor that can be registered with the supervisor
 */
export function createHotReloadDescriptor(opts: HotReloadOpts): ServiceDescriptor {
  return {
    name: 'hot-reload',
    restart: 'permanent',
    shareable: true,
    
    // eslint-disable-next-line @typescript-eslint/require-await
    async create({ logger }: ServiceCreateOpts) {
      let active = false;
      
      // Expose rebuild trigger globally
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (globalThis as any).alefRequestRebuild = async () => {
        logger?.info({}, 'Hot reload: build starting');
        
        try {
          // Run build command
          const { stderr } = await execAsync(opts.buildCommand, { 
            cwd: opts.cwd 
          });
          
          if (stderr) {
            logger?.warn({ stderr }, 'Build warnings');
          }
          
          logger?.info({}, 'Hot reload: build passed, swapping session');
          
          // Trigger session swap
          await opts.swap(opts.sessionServiceName, { 
            cwd: opts.cwd,
            logger 
          });
          
          logger?.info({}, 'Hot reload: complete');
        } catch (err) {
          logger?.error({ err }, 'Hot reload failed');
          throw err;
        }
      };
      
      return {
        name: 'hot-reload',
        restart: 'permanent',
        adapters: [],
        tools: [],
        
        // eslint-disable-next-line @typescript-eslint/require-await
        async start() {
          active = true;
          logger?.info({}, 'Hot reload service ready');
        },
        
        // eslint-disable-next-line @typescript-eslint/require-await
        async stop() {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
          delete (globalThis as any).alefRequestRebuild;
          active = false;
        },
        
        // eslint-disable-next-line @typescript-eslint/require-await
        async health() {
          return active;
        },
      };
    },
  };
}
