export type RenderState = {
  content: string;
  visible: boolean;
  height: number | string;
};

export function hasRenderStateChanged(previous: RenderState | undefined, next: RenderState) {
  return !previous || previous.content !== next.content || previous.visible !== next.visible || previous.height !== next.height;
}
