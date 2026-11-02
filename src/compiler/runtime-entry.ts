/**
 * Runtime bundled into every compiled composition (window.MGE). It is the
 * same evaluator + renderer the editor uses, so exports match the preview.
 */
import { evaluateComposition } from "../core/evaluate";
import type { Project } from "../core/types";
import { SvgRenderer } from "../render/renderer";

export function mount(project: Project, compId: string, container: Element) {
  const comp = project.compositions.find((c) => c.id === compId) ?? project.compositions[0];
  const renderer = new SvgRenderer(container);
  let last = -1;
  return {
    comp,
    seek(t: number) {
      if (t === last) return;
      last = t;
      renderer.render(evaluateComposition(project, comp, t, { includeReference: false }));
    },
  };
}
