export type PluginTransformResult = {
  source: string;
  plugins: string[];
  changed: boolean;
};

export function readPluginSpecs(source: string): string[];
export function addLocalPlugin(source: string, localPath: string): PluginTransformResult;
export function revertLocalPlugin(source: string, localPath: string, officialSpec: string): PluginTransformResult;
