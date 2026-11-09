export declare const VERSION: string;
export declare const DEFAULT_REGISTRY: string;
export declare const DEFAULT_SOURCE: string;
export declare const INSTALL_MARKER: string;
export declare const LOCAL_MARKER: string;
export declare const TEMPLATE_FILES: readonly string[];

export interface Ports {
  api: number;
  admin: number;
  db: number;
  valkey: number;
}

export declare function templatesDir(): string;
export declare function secret(): string;
export declare function checkInstance(name: string): string;
export declare function instanceFromName(name: string): string;
export declare function instanceInUse(instance: string): boolean;
export declare function portFree(port: number): Promise<boolean>;
export declare function freePort(start: number, taken?: Set<number>): Promise<number>;

export declare function renderProductionEnv(
  example: string,
  opts: {
    instance: string;
    ports: Ports;
    apiImage: string;
    adminImage: string;
    secret?: () => string;
  }
): string;

export declare function composeForImages(text: string, version: string): string;

export declare function renderLocalEnv(
  apiExample: string,
  opts: { ports: Ports; secret?: () => string }
): { root: string; api: string };

export interface ScaffoldOptions {
  dir: string;
  mode?: "docker" | "local";
  instance?: string;
  ports?: Partial<Ports>;
  probe?: boolean;
  registry?: string;
  imageTag?: string;
  source?: string;
  ref?: string;
  secret?: () => string;
}

export interface ScaffoldResult {
  dir: string;
  mode: "docker" | "local";
  instance?: string;
  ports: Ports;
  cloned?: boolean;
  files: string[];
  kept?: string[];
  next: string[];
}

export declare function scaffold(o: ScaffoldOptions): Promise<ScaffoldResult>;
