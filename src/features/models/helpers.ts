import type { OllamaModel } from "../../contracts/ipc";

export function modelName(model: OllamaModel): string {
  return model.name ?? model.model ?? "未知模型";
}

export function modelAlias(alias: string | undefined, model: string): string {
  return alias?.trim() || model;
}

export function modelAliasFor(
  aliases: Record<string, string> | undefined,
  model: string,
  fallback?: string,
): string {
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, model)) {
    return modelAlias(aliases[model], model);
  }
  return modelAlias(fallback, model);
}
