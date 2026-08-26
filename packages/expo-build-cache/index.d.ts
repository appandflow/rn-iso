interface RunOptions {
  variant?: unknown;
  configuration?: unknown;
  buildConfiguration?: unknown;
  isSimulator?: unknown;
  device?: unknown;
}
export declare function cacheRoot(): string;
export declare function buildCacheKey(platform: string, fingerprintHash: string, runOptions?: RunOptions): string;
export declare function resolveBuildCache({
  platform,
  fingerprintHash,
  runOptions,
}: {
  platform: string;
  fingerprintHash: string;
  runOptions?: RunOptions;
}): Promise<string | null>;
export declare function uploadBuildCache({
  platform,
  fingerprintHash,
  buildPath,
  runOptions,
}: {
  platform: string;
  fingerprintHash: string;
  buildPath?: string;
  runOptions?: RunOptions;
}): Promise<string | null>;
export {};
