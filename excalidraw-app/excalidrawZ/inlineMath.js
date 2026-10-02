import { getAPI } from "./_helpers";
import { createElements } from "./creators";
import { CaptureUpdate } from "./elements";
import { createMathImage } from "./math";
import { sendMessage } from "./message";

/**
 * Inline LaTeX: when a standalone text element's editing session ends and
 * its whole text is a single math expression (`$…$`, `$$…$$`, `\(…\)` or
 * `\[…\]`), ask the host to render it and swap the text for a tagged math
 * image at the same position. The original text is kept in
 * `customData.excalidrawZ.inlineSource` so the image can be turned back
 * into an editable text element (see `restoreInlineMathText`).
 *
 * Rendering happens natively (MathJax lives in the host, not in this
 * bundle), so the flow is:
 *   text submit → `requestRenderInlineMath` (JS→Swift)
 *   → `replaceTextWithMathImage` (Swift→JS)
 */

// MathJax SVG from the host is rendered with `em: 16`, so scale by fontSize/16
// to match the text element's font size.
const RENDER_EM_PX = 16;

const DELIMITERS = [
  ["$$", "$$"],
  ["\\[", "\\]"],
  ["\\(", "\\)"],
  ["$", "$"],
];

let inlineLatexEnabled = false;
let lastEditingTextElementId = null;
let trackingStarted = false;

export const setInlineLatexEnabled = (enabled) => {
  inlineLatexEnabled = enabled === true;
  return { enabled: inlineLatexEnabled };
};

export const getInlineLatexEnabled = () => inlineLatexEnabled;

/**
 * @param {string} text
 * @returns {{ latex: string, open: string, close: string } | null}
 */
export const parseInlineMath = (text) => {
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  for (const [open, close] of DELIMITERS) {
    if (
      trimmed.length > open.length + close.length &&
      trimmed.startsWith(open) &&
      trimmed.endsWith(close)
    ) {
      const latex = trimmed.slice(open.length, trimmed.length - close.length);
      if (!latex.trim()) {
        return null;
      }
      // `$a$ and $b$` is prose, not a single expression.
      if (open === "$" && latex.includes("$")) {
        return null;
      }
      return { latex: latex.trim(), open, close };
    }
  }
  return null;
};

const isConvertibleTextElement = (element) =>
  !!element &&
  element.type === "text" &&
  !element.isDeleted &&
  !element.containerId &&
  !element.customData?.excalidrawZ;

const requestRender = (element) => {
  const parsed = parseInlineMath(element.originalText ?? element.text);
  if (!parsed) {
    return false;
  }
  sendMessage({
    event: "requestRenderInlineMath",
    data: {
      textElementId: element.id,
      latex: parsed.latex,
      originalText: element.originalText ?? element.text,
      fontSize: element.fontSize,
      strokeColor: element.strokeColor,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      angle: element.angle,
      opacity: element.opacity,
    },
  });
  return true;
};

/**
 * Watch for text editing sessions ending. Idempotent; called from
 * `notifyHelperReady` once the API is bridged.
 */
export const startInlineMathTracking = () => {
  const api = getAPI();
  if (trackingStarted || !api || typeof api.onChange !== "function") {
    return;
  }
  trackingStarted = true;
  api.onChange((elements, appState) => {
    const editingId = appState?.editingTextElement?.id ?? null;
    if (editingId) {
      lastEditingTextElementId = editingId;
      return;
    }
    if (!lastEditingTextElementId) {
      return;
    }
    const finishedId = lastEditingTextElementId;
    lastEditingTextElementId = null;
    if (!inlineLatexEnabled) {
      return;
    }
    const element = elements.find((candidate) => candidate.id === finishedId);
    if (isConvertibleTextElement(element)) {
      requestRender(element);
    }
  });
};

/**
 * Host callback: replace a text element with the rendered math image.
 *
 * @param {string} textElementId
 * @param {{ svg?: string, svgBase64?: string, dataURL?: string, latex: string,
 *   renderer?: string, width?: number, height?: number, originalText?: string }} params
 * @returns {{ elementId: string, fileId: string } | null}
 */
export const replaceTextWithMathImage = (textElementId, params = {}) => {
  const api = getAPI();
  if (!api) {
    throw new Error("replaceTextWithMathImage: excalidrawAPI not ready");
  }
  const textElement = api
    .getSceneElements()
    .find((candidate) => candidate.id === textElementId);
  if (!isConvertibleTextElement(textElement)) {
    return null;
  }
  const originalText = textElement.originalText ?? textElement.text;
  if (
    typeof params.originalText === "string" &&
    params.originalText !== originalText
  ) {
    // Text changed again while the host was rendering; drop the stale result.
    return null;
  }
  const parsed = parseInlineMath(originalText);
  if (!parsed) {
    return null;
  }

  const scale = (textElement.fontSize || RENDER_EM_PX) / RENDER_EM_PX;
  const created = createMathImage({
    svg: params.svg,
    svgBase64: params.svgBase64,
    dataURL: params.dataURL,
    latex: params.latex ?? parsed.latex,
    renderer: params.renderer,
    x: textElement.x,
    y: textElement.y,
    width: params.width ? params.width * scale : undefined,
    height: params.height ? params.height * scale : undefined,
    angle: textElement.angle,
    opacity: textElement.opacity,
    mathData: {
      inlineSource: originalText,
      inlineDelimiters: [parsed.open, parsed.close],
      inlineFontSize: textElement.fontSize,
      inlineFontFamily: textElement.fontFamily,
      inlineTextAlign: textElement.textAlign,
      inlineStrokeColor: textElement.strokeColor,
    },
  });
  const image = created.elements[0];

  api.addFiles(Object.values(created.files));
  api.mutateElement(textElement, { isDeleted: true });
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), image],
    appState: { selectedElementIds: { [image.id]: true } },
    captureUpdate: CaptureUpdate.IMMEDIATELY,
  });

  return { elementId: image.id, fileId: created.fileId };
};

/**
 * Turn an inline-converted math image back into a selected text element so
 * it can be edited in place (Enter opens the editor; submitting re-renders).
 *
 * @param {string} elementId
 * @returns {{ elementId: string } | null}
 */
export const restoreInlineMathText = (elementId) => {
  const api = getAPI();
  if (!api) {
    throw new Error("restoreInlineMathText: excalidrawAPI not ready");
  }
  const image = api
    .getSceneElements()
    .find((candidate) => candidate.id === elementId);
  const mathData = image?.customData?.excalidrawZ;
  if (
    !image ||
    image.type !== "image" ||
    mathData?.type !== "math" ||
    typeof mathData.inlineSource !== "string"
  ) {
    return null;
  }

  const [text] = createElements([
    {
      type: "text",
      x: image.x,
      y: image.y,
      text: mathData.inlineSource,
      fontSize: mathData.inlineFontSize,
      fontFamily: mathData.inlineFontFamily,
      textAlign: mathData.inlineTextAlign,
      strokeColor: mathData.inlineStrokeColor,
      angle: image.angle,
      opacity: image.opacity,
    },
  ]);

  api.mutateElement(image, { isDeleted: true });
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), text],
    appState: { selectedElementIds: { [text.id]: true } },
    captureUpdate: CaptureUpdate.IMMEDIATELY,
  });

  return { elementId: text.id };
};
