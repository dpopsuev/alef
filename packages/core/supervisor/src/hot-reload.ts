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

export function createHotReloadDescriptor(opts: HotReloadOpts): ServiceDescriptor {
  return {
    name: 'hot-reload',
    restart: 'permanent',
    shareable: true,
    
    async create({ logger }: ServiceCreateOpts) {
      let active = false;
      
      // Expose rebuild trigger globally
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
        
        async start() {
          active = true;
          logger?.info({}, 'Hot reload service ready');
        },
        
        async stop() {
          delete (globalThis as any).alefRequestRebuild;
          active = false;
        },
        
        async health() {
          return active;
        },
      };
    },
  };
}
