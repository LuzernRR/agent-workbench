export type V2ComposerSubmitMode = "enqueue" | "steer";
export type V2ComposerKeyRoute = "ignore" | "newline" | "send" | V2ComposerSubmitMode;

export interface V2ComposerKeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly nativeIsComposing: boolean;
}

export function routeV2ComposerKey(
  input: V2ComposerKeyInput,
  activeRun: boolean
): V2ComposerKeyRoute {
  if (input.key !== "Enter") return "ignore";
  if (input.repeat || input.isComposing || input.nativeIsComposing) return "ignore";
  if (input.shiftKey) return "newline";
  if (!activeRun) return "send";
  return input.ctrlKey || input.metaKey ? "steer" : "enqueue";
}

export function routeV2ComposerClick(
  activeRun: boolean,
  selectedMode: V2ComposerSubmitMode
): "send" | V2ComposerSubmitMode {
  return activeRun ? selectedMode : "send";
}
